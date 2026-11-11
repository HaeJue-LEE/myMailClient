import type { Account } from "@/features/mail/mail-accounts";

/** A steady colour per address, so each account is recognisable at a glance. */
export function avatarHue(email: string) {
  let hash = 0;
  for (const char of email) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** The letter shown when an account has no picture. */
export function avatarLetter(account: Pick<Account, "name" | "email">) {
  return (account.name || account.email.split("@")[0] || account.email).charAt(0).toUpperCase();
}

/**
 * An account as a round picture: the image chosen for it in the account
 * settings, else its first letter on its own colour.
 */
export function AccountAvatar({
  account,
  className = "",
}: {
  account: Pick<Account, "name" | "email" | "avatar">;
  /** Size, ring, animation and the like. */
  className?: string;
}) {
  // Only pictures stored by the app (PNG data URLs) are shown.
  if (account.avatar?.startsWith("data:image/png;base64,")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a local data URL; next/image adds nothing.
      <img
        aria-hidden
        alt=""
        src={account.avatar}
        draggable={false}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `hsl(${avatarHue(account.email)} 55% 45%)` }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
    >
      {avatarLetter(account)}
    </span>
  );
}
