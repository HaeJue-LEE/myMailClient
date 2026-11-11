"use client";

import { type KeyboardEvent, useId, useState } from "react";
import { parseAddresses } from "@/features/mail/addresses";
import {
  completedRecipientText,
  CONTACT_SOURCE_LABEL,
  currentRecipientText,
  formatRecipient,
  matchContacts,
  replaceCurrentRecipient,
} from "@/features/mail/contacts";
import type { Contact } from "@/features/mail/types";

/**
 * A comma-separated recipient field that suggests contacts for the entry
 * being typed. ↑/↓ move, Enter or Tab picks, Esc closes.
 */
export function RecipientInput({
  id,
  name,
  contacts,
  defaultValue = "",
  autoFocus,
  className,
  invalid,
  describedBy,
}: {
  id: string;
  name: string;
  contacts: readonly Contact[];
  defaultValue?: string;
  autoFocus?: boolean;
  className?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const listboxId = useId();
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const suggestions = open
    ? matchContacts(contacts, currentRecipientText(value), {
        // Addresses already in the field are not offered again.
        exclude: parseAddresses(completedRecipientText(value)).valid,
      })
    : [];
  const expanded = suggestions.length > 0;
  const highlighted = Math.min(active, suggestions.length - 1);

  const pick = (contact: Contact) => {
    setValue(replaceCurrentRecipient(value, formatRecipient(contact)));
    setActive(0);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!expanded) return;
    const count = suggestions.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((highlighted + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((highlighted - 1 + count) % count);
    } else if (event.key === "Enter" || event.key === "Tab") {
      // Enter would otherwise submit the form; Tab would leave the field.
      event.preventDefault();
      pick(suggestions[highlighted]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={keyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder="이름이나 주소를 입력하면 연락처가 나옵니다. 여러 명은 쉼표로 구분"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={expanded ? `${listboxId}-${highlighted}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={className}
      />
      {expanded && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="연락처 제안"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-foreground/10 bg-background py-1 shadow-lg"
        >
          {suggestions.map((contact, index) => (
            <li
              key={contact.email}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              // Keep focus in the field so blur does not close the list before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(contact)}
              className="flex cursor-pointer items-center gap-3 px-3 py-1.5 aria-selected:bg-foreground/5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {contact.name || contact.email}
                </span>
                {contact.name && (
                  <span className="block truncate text-xs opacity-60">
                    {contact.email}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs opacity-50">
                {CONTACT_SOURCE_LABEL[contact.source]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
