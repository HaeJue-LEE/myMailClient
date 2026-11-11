import { describe, expect, it } from "vitest";
import {
  newPersonBody,
  PERSON_RESOURCE,
  replaceEmail,
  toContacts,
} from "./contacts";

describe("toContacts resourceName", () => {
  it("keeps it for saved people only, and only in the people/<id> form", () => {
    const person = {
      resourceName: "people/c123",
      emailAddresses: [{ value: "a@x.com" }],
    };
    expect(toContacts([person], "google", "me@gmail.com")[0].resourceName).toBe("people/c123");
    expect(toContacts([person], "other", "me@gmail.com")[0]).not.toHaveProperty("resourceName");
    expect(
      toContacts([{ ...person, resourceName: "people/../x" }], "google", "me@gmail.com")[0],
    ).not.toHaveProperty("resourceName");
  });

  it("accepts only people/<id> resource names", () => {
    expect(PERSON_RESOURCE.test("people/c8765_ab-1")).toBe(true);
    for (const bad of ["otherContacts/c1", "people/", "people/c1/x", "people/c1:deleteContact"]) {
      expect(PERSON_RESOURCE.test(bad)).toBe(false);
    }
  });
});

describe("replaceEmail", () => {
  const addresses = [
    { value: "Home@x.com", type: "home", formattedType: "Home" },
    { value: "work@x.com", type: "work" },
    { value: null },
  ];

  it("changes only the matching address and keeps its type", () => {
    expect(replaceEmail(addresses, "home@x.com", "new@x.com")).toEqual([
      { value: "new@x.com", type: "home" },
      { value: "work@x.com", type: "work" },
    ]);
  });

  it("adds the address when the old one is gone", () => {
    expect(replaceEmail(addresses, "gone@x.com", "new@x.com")).toEqual([
      { value: "Home@x.com", type: "home" },
      { value: "work@x.com", type: "work" },
      { value: "new@x.com" },
    ]);
  });
});

describe("newPersonBody", () => {
  it("sends the name as one free-form value, or none at all", () => {
    expect(newPersonBody({ name: "홍길동", email: "hong@x.com" })).toEqual({
      names: [{ unstructuredName: "홍길동" }],
      emailAddresses: [{ value: "hong@x.com" }],
    });
    expect(newPersonBody({ name: "", email: "hong@x.com" })).toEqual({
      emailAddresses: [{ value: "hong@x.com" }],
    });
  });
});

describe("toContacts", () => {
  it("makes one contact per email address, lower-cased", () => {
    expect(
      toContacts(
        [
          {
            names: [{ displayName: " 홍길동 " }],
            emailAddresses: [{ value: "Hong@Example.com" }, { value: "h2@x.com" }],
          },
          { emailAddresses: [{ value: "noname@x.com" }] },
          { names: [{ displayName: "No Email" }] },
          { emailAddresses: [{ value: "  " }, { value: null }] },
        ],
        "other",
        "me@gmail.com",
      ),
    ).toEqual([
      { name: "홍길동", email: "hong@example.com", source: "other", accounts: ["me@gmail.com"] },
      { name: "홍길동", email: "h2@x.com", source: "other", accounts: ["me@gmail.com"] },
      { name: "", email: "noname@x.com", source: "other", accounts: ["me@gmail.com"] },
    ]);
  });
});
