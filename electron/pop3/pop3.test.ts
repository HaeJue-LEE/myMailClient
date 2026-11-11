import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountCredentials } from "../accounts";
import { InvalidRequestError, MailServerError } from "../errors";
import { buildMimeMessage } from "../gmail/mime";
import { toImapSearch } from "../imap/query";
import { ReplyReader, unstuff, verifyPop3, withPop3 } from "./client";
import { matchesSearch } from "./search";

let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const smtpSends: { from: string; recipients: string[]; raw: string }[] = [];
vi.mock("../imap/smtp", () => ({
  sendSmtp: async (_config: unknown, message: { from: string; recipients: string[]; raw: string }) => {
    smtpSends.push(message);
  },
}));

const { createPop3Backend, decodePop3Id, encodePop3Id, headersSuggestAttachment } = await import("./backend");

const CRLF = "\r\n";

/** "회의 일정" in EUC-KR, as raw 8-bit header bytes (no encoded word). */
const EUC_KR_SUBJECT = Buffer.from([0xc8, 0xb8, 0xc0, 0xc7, 0x20, 0xc0, 0xcf, 0xc1, 0xa4]);

const message = (subject: string | Buffer, from: string, body: string, extra = "") =>
  Buffer.concat([
    Buffer.from(`From: ${from}${CRLF}To: me@company.co.kr${CRLF}Subject: `),
    Buffer.from(subject),
    Buffer.from(
      `${CRLF}Date: Tue, 10 Nov 2026 09:00:00 +0900${CRLF}` +
        `MIME-Version: 1.0${CRLF}${extra}Content-Type: text/plain; charset=utf-8${CRLF}${CRLF}${body}`,
    ),
  ]);

const MAILBOX = [
  { uid: "uid-1", raw: message("첫 메일", "\"김철수\" <kim@example.com>", `안녕하세요${CRLF}.점으로 시작하는 줄${CRLF}끝`) },
  {
    uid: "uid-2",
    raw: message(EUC_KR_SUBJECT, "lee@example.com", "본문", ""),
  },
  { uid: "uid-3", raw: message("=?UTF-8?B?7KO86rCEIOuztOqzoA==?=", "park@example.com", "주간 보고 본문") },
  // A copy this app sent to the account itself: kept on the server, not listed.
  {
    uid: "uid-4",
    raw: message("[내가보낸메일] 견적서", "me@company.co.kr", "보낸 내용", `X-Mail-Client-Copy: sent${CRLF}`),
  },
];

/** Dot-stuffs a message for a multi-line reply. */
const stuffed = (raw: Buffer) =>
  Buffer.from(
    raw
      .toString("latin1")
      .split(CRLF)
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join(CRLF),
    "latin1",
  );

type Server = { port: number; commands: string[]; close: () => Promise<void> };

/**
 * A POP3 server that answers in deliberately tiny chunks, so replies are split
 * at every awkward place (inside CRLF, inside the terminator).
 */
async function startServer(
  options: { password?: string; noTop?: boolean; mailbox?: { uid: string; raw: Buffer }[] } = {},
): Promise<Server> {
  const mailbox = options.mailbox ?? MAILBOX;
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    const write = (data: Buffer | string) => {
      const bytes = Buffer.from(data);
      for (let i = 0; i < bytes.length; i += 3) socket.write(bytes.subarray(i, i + 3));
    };
    const multi = (status: string, body: Buffer) =>
      write(Buffer.concat([Buffer.from(`+OK ${status}${CRLF}`), stuffed(body), Buffer.from(`${CRLF}.${CRLF}`)]));
    write(`+OK Hiworks-POP3S test${CRLF}`);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("latin1");
      let end: number;
      while ((end = pending.indexOf(CRLF)) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const [command, ...args] = line.split(" ");
        commands.push(command === "PASS" ? "PASS" : line);
        if (command === "USER") write(`+OK${CRLF}`);
        else if (command === "PASS") {
          if (args.join(" ") === (options.password ?? "pw")) write(`+OK signed in${CRLF}`);
          else write(`-ERR invalid password${CRLF}`);
        } else if (command === "UIDL") {
          multi("", Buffer.from(mailbox.map((m, i) => `${i + 1} ${m.uid}`).join(CRLF)));
        } else if (command === "TOP") {
          if (options.noTop) {
            write(`-ERR command TOP is not implemented.${CRLF}`);
            continue;
          }
          const raw = mailbox[Number(args[0]) - 1].raw;
          const split = raw.indexOf(`${CRLF}${CRLF}`);
          multi("", raw.subarray(0, split + 2));
        } else if (command === "RETR") {
          multi("", mailbox[Number(args[0]) - 1].raw);
        } else if (command === "QUIT") {
          write(`+OK bye${CRLF}`);
          socket.end();
        } else write(`-ERR unknown${CRLF}`);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    commands,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const credentials = (port: number, password = "pw"): MailAccountCredentials => ({
  id: "acct",
  name: "",
  email: "me@company.co.kr",
  username: "me@company.co.kr",
  password,
  protocol: "pop3",
  incoming: { host: "127.0.0.1", port, security: "none" },
  outgoing: { host: "127.0.0.1", port: 1, security: "none" },
  saveSentCopy: true,
  sendCopyToSelf: false,
});

describe("reply reader", () => {
  it("reads replies split and merged at any byte", async () => {
    const reader = new ReplyReader();
    const wire = Buffer.from(`+OK hi${CRLF}+OK${CRLF}a${CRLF}..b${CRLF}.${CRLF}+OK${CRLF}.${CRLF}-ERR no${CRLF}`);
    const replies = [reader.next(false)];
    for (const byte of wire) reader.push(Buffer.from([byte]));
    expect((await replies[0]).status).toBe("+OK hi");
    // Already buffered: the next replies come without more input.
    const body = await reader.next(true);
    expect(body.body?.toString()).toBe(`a${CRLF}.b`);
    expect((await reader.next(true)).body?.length).toBe(0);
    // A -ERR reply to a multi-line command has no body.
    expect(await reader.next(true)).toEqual({ status: "-ERR no", body: null });
  });

  it("reads a large message arriving in many chunks", async () => {
    const reader = new ReplyReader();
    const line = "x".repeat(70);
    const body = Array.from({ length: 5000 }, (_, i) => (i % 100 === 0 ? `.${line}` : line)).join(CRLF);
    const wire = Buffer.concat([Buffer.from(`+OK${CRLF}`), stuffed(Buffer.from(body)), Buffer.from(`${CRLF}.${CRLF}+OK next${CRLF}`)]);
    const reply = reader.next(true);
    for (let i = 0; i < wire.length; i += 1000) reader.push(wire.subarray(i, i + 1000));
    expect((await reply).body?.toString()).toBe(body);
    expect((await reader.next(false)).status).toBe("+OK next");
  });

  it("undoes dot-stuffing", () => {
    expect(unstuff(Buffer.from(`..x${CRLF}y${CRLF}...`)).toString()).toBe(`.x${CRLF}y${CRLF}..`);
  });

  it("fails a waiting reply when the connection breaks", async () => {
    const reader = new ReplyReader();
    const reply = reader.next(false);
    reader.fail(new Error("closed"));
    await expect(reply).rejects.toThrow("closed");
  });
});

describe("message ids", () => {
  it("round-trips server and local ids", () => {
    for (const ref of [
      { where: "server", uid: "AAAAbbb+/=:1" },
      { where: "local", folder: "drafts", name: "0b8f8b8e-5a1c-4f7e-9d7a-1a2b3c4d5e6f" },
      { where: "local", folder: "sent", name: "0b8f8b8e-5a1c-4f7e-9d7a-1a2b3c4d5e6f" },
    ] as const) {
      expect(decodePop3Id(encodePop3Id(ref))).toEqual(ref);
    }
  });

  it("rejects anything else, including paths", () => {
    for (const id of ["", "m.", "x.abc", "d.../../etc", "s.not-a-uuid", "SU5CT1g.1.2"]) {
      expect(() => decodePop3Id(id), id).toThrow(InvalidRequestError);
    }
  });
});

describe("header search", () => {
  const facts = {
    subject: "주간 보고",
    from: '"김철수" <kim@example.com>',
    to: "me@company.co.kr",
    cc: "",
    bcc: "",
    date: new Date(2026, 10, 10, 9).getTime(),
    seen: false,
    flagged: true,
  };
  const matches = (query: string) => matchesSearch(toImapSearch(query), facts);

  it("matches the list filters and sender and text searches", () => {
    expect(matches("")).toBe(true);
    expect(matches("is:unread")).toBe(true);
    expect(matches("is:read")).toBe(false);
    expect(matches("is:starred")).toBe(true);
    expect(matches("from:kim@example.com")).toBe(true);
    expect(matches("from:lee@example.com")).toBe(false);
    expect(matches("김철수")).toBe(true);
    expect(matches("보고")).toBe(true);
    expect(matches("휴가")).toBe(false);
    expect(matches("after:2026/11/10")).toBe(true);
    expect(matches("after:2026/11/11")).toBe(false);
    expect(matches("before:2026/11/11")).toBe(true);
    expect(matches("-from:kim@example.com")).toBe(false);
    expect(matches('{from:"x@y.com" to:"me@company.co.kr"}')).toBe(true);
  });
});

describe("POP3 session", () => {
  let server: Server;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(() => server.close());

  it("lists, reads headers without bodies, and retrieves", async () => {
    const result = await withPop3(credentials(server.port), async (pop) => {
      const list = await pop.uidl();
      const headers = await pop.headers(1);
      const whole = await pop.retrieve(1);
      return { list, headers, whole };
    });
    expect(result.list).toEqual([
      { number: 1, uid: "uid-1" },
      { number: 2, uid: "uid-2" },
      { number: 3, uid: "uid-3" },
      { number: 4, uid: "uid-4" },
    ]);
    expect(result.headers.toString()).toContain("Subject: 첫 메일");
    expect(result.headers.toString()).not.toContain("안녕하세요");
    expect(result.whole.equals(MAILBOX[0].raw)).toBe(true);
    expect(server.commands.at(-1)).toBe("QUIT");
  });

  it("reports a refused password as auth_failed, without the password", async () => {
    const error = await withPop3(credentials(server.port, "wrong-pw"), async () => null).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MailServerError);
    expect((error as MailServerError).code).toBe("auth_failed");
    expect((error as Error).message).not.toContain("wrong-pw");
  });

  it("reports an unreachable server as connection_failed", async () => {
    await server.close();
    const error = await verifyPop3(credentials(server.port)).catch((e: unknown) => e);
    expect((error as MailServerError).code).toBe("connection_failed");
    server = await startServer();
  });

  it("refuses at setup time a server without TOP", async () => {
    const noTop = await startServer({ noTop: true });
    try {
      const error = await verifyPop3(credentials(noTop.port)).catch((e: unknown) => e);
      expect((error as MailServerError).code).toBe("server_error");
      await expect(verifyPop3(credentials(server.port))).resolves.toBeUndefined();
    } finally {
      await noTop.close();
    }
  });
});

describe("POP3 backend", () => {
  let server: Server;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "pop3-"));
    server.commands.length = 0;
  });
  afterEach(() => rm(userData, { recursive: true, force: true }));

  it("lists the inbox from headers alone, newest first", async () => {
    const backend = createPop3Backend({ ...credentials(server.port), id: `a-${Math.random()}` });
    const page = await backend.listThreads({ labelId: "INBOX" });
    expect(page.threads.map((thread) => thread.subject)).toEqual(["주간 보고", "회의 일정", "첫 메일"]);
    expect(page.threads[2]).toMatchObject({ from: "김철수", fromAddress: "kim@example.com", unread: true, snippet: "" });
    expect(page.nextPageToken).toBeNull();
    // Headers only: no message was downloaded, and nothing was deleted.
    expect(server.commands.some((command) => /^(RETR|DELE)/.test(command))).toBe(false);
  });

  it("downloads a body when opened and keeps read state locally", async () => {
    const backend = createPop3Backend({ ...credentials(server.port), id: `a-${Math.random()}` });
    const { threads } = await backend.listThreads({ labelId: "INBOX" });
    const first = threads[2];
    const thread = await backend.getThread(first.id);
    expect(thread.messages[0].text).toContain(".점으로 시작하는 줄");
    expect(thread.messages[0].unread).toBe(true);

    await backend.modifyThreads([first.id], { addLabelIds: [], removeLabelIds: ["UNREAD"] });
    const unread = await backend.listThreads({ labelId: "INBOX", query: "is:unread" });
    expect(unread.threads.map((t) => t.subject)).toEqual(["주간 보고", "회의 일정"]);

    await backend.modifyThreads([first.id], { addLabelIds: ["STARRED"], removeLabelIds: [] });
    const starred = await backend.listThreads({ labelId: "STARRED" });
    expect(starred.threads.map((t) => t.id)).toEqual([first.id]);
    expect(server.commands.some((command) => command.startsWith("DELE"))).toBe(false);
  });

  it("sends a copy titled [내가보낸메일] to itself only, leaving the recipients' mail as is", async () => {
    smtpSends.length = 0;
    const backend = createPop3Backend({
      ...credentials(server.port),
      id: `a-${Math.random()}`,
      sendCopyToSelf: true,
    });
    await backend.sendMessage({
      to: ["kim@example.com"],
      cc: [],
      bcc: ["boss@example.com"],
      subject: "견적서",
      text: "첨부합니다",
    });
    expect(smtpSends).toHaveLength(2);
    const [original, copy] = smtpSends;
    expect(original.recipients).toEqual(["kim@example.com", "boss@example.com"]);
    expect(original.raw).toMatch(/^Subject: =\?UTF-8\?B\?6rKs7KCB7ISc\?=$/m);
    expect(original.raw).not.toMatch(/X-Mail-Client-Copy|^Bcc:/m);
    expect(copy.recipients).toEqual(["me@company.co.kr"]);
    expect(copy.raw).toMatch(/^X-Mail-Client-Copy: sent\r\n/);
    // The copy records the hidden recipients too; it goes to no one else.
    expect(copy.raw).toMatch(/^Bcc: boss@example.com/m);
    const { simpleParser } = await import("mailparser");
    const parsedCopy = await simpleParser(copy.raw);
    expect(parsedCopy.subject).toBe("[내가보낸메일] 견적서");
    const parsedOriginal = await simpleParser(original.raw);
    expect(parsedCopy.messageId).not.toBe(parsedOriginal.messageId);

    // Without the option only the recipients' mail goes out.
    smtpSends.length = 0;
    await createPop3Backend({ ...credentials(server.port), id: `a-${Math.random()}` }).sendMessage({
      to: ["kim@example.com"],
      cc: [],
      bcc: [],
      subject: "견적서",
      text: "첨부합니다",
    });
    expect(smtpSends).toHaveLength(1);
  });

  it("never deletes server mail, but keeps drafts on this computer", async () => {
    const backend = createPop3Backend({ ...credentials(server.port), id: `a-${Math.random()}` });
    const { threads } = await backend.listThreads({ labelId: "INBOX" });
    await expect(backend.trashThreads([threads[0].id])).rejects.toThrow(InvalidRequestError);

    const draft = { to: ["kim@example.com"], cc: [], bcc: [], subject: "초안", text: "내용" };
    const { draftId } = await backend.saveDraft(draft);
    const { draftId: second } = await backend.saveDraft({ ...draft, subject: "초안 2", draftId });
    const drafts = await backend.listThreads({ labelId: "DRAFT" });
    expect(drafts.threads.map((t) => t.subject)).toEqual(["초안 2"]);
    expect((await backend.openDraft(second)).subject).toBe("초안 2");
    await backend.deleteDraft(second);
    expect((await backend.listThreads({ labelId: "DRAFT" })).threads).toEqual([]);
    expect(server.commands.some((command) => command.startsWith("DELE"))).toBe(false);
  });
});

describe("attachment guess from headers", () => {
  const guess = async (headers: string) => {
    const { simpleParser } = await import("mailparser");
    return headersSuggestAttachment(await simpleParser(`${headers}${CRLF}${CRLF}`));
  };

  it("believes Outlook's own header", async () => {
    expect(await guess(`X-MS-Has-Attach: yes${CRLF}Content-Type: multipart/related; boundary=a`)).toBe(true);
    // A card or logo only: Outlook says no even though the message is mixed.
    expect(await guess(`X-MS-Has-Attach:${CRLF}Content-Type: text/plain`)).toBe(false);
    expect(await guess(`X-MS-Has-Attach: no${CRLF}Content-Type: multipart/mixed; boundary=a`)).toBe(false);
  });

  it("does not guess from the message type (Hiworks sends all mail as multipart/mixed)", async () => {
    expect(await guess(`Content-Type: multipart/mixed; boundary="b"`)).toBe(false);
    expect(await guess(`Content-Type: multipart/alternative; boundary="b"`)).toBe(false);
    expect(await guess(`Content-Type: text/plain; charset=utf-8`)).toBe(false);
  });
});

describe("POP3 attachment flags", () => {
  const mail = (subject: string, attachments: { filename: string; mimeType: string }[]) =>
    Buffer.from(
      buildMimeMessage({
        from: "kim@example.com",
        to: ["me@company.co.kr"],
        subject,
        text: "본문",
        html: "<p>본문</p>",
        attachments: attachments.map((a) => ({ ...a, data: Buffer.from("x".repeat(100)) })),
      }),
    );
  // Both are multipart/mixed, as Hiworks sends every mail.
  const mailbox = [
    { uid: "card-only", raw: mail("명함만", [{ filename: "명함.vcf", mimeType: "text/vcard" }]) },
    { uid: "with-pdf", raw: mail("견적서", [{ filename: "견적서.pdf", mimeType: "application/pdf" }]) },
  ];
  let server: Server;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "pop3-flags-"));
    server = await startServer({ mailbox });
  });
  afterEach(async () => {
    await server.close();
    await rm(userData, { recursive: true, force: true });
  });

  it("shows no clip until a message is opened, then keeps what opening showed", async () => {
    const account = { ...credentials(server.port), id: `flags-${Math.random()}` };
    const flags = async (backend: ReturnType<typeof createPop3Backend>) =>
      Object.fromEntries(
        (await backend.listThreads({ labelId: "INBOX" })).threads.map((t) => [t.subject, t.hasAttachment]),
      );

    const backend = createPop3Backend(account);
    expect(await flags(backend)).toEqual({ 견적서: false, 명함만: false });

    for (const thread of (await backend.listThreads({ labelId: "INBOX" })).threads) {
      await backend.getThread(thread.id);
    }
    expect(await flags(backend)).toEqual({ 견적서: true, 명함만: false });

    // As after a restart: the module's caches are gone, the stored flags are not.
    vi.resetModules();
    const fresh = (await import("./backend")).createPop3Backend(account);
    expect(await flags(fresh)).toEqual({ 견적서: true, 명함만: false });
    expect(server.commands.some((command) => command.startsWith("DELE"))).toBe(false);
  });
});
