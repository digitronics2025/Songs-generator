export function parseOwnerEmails(value = ""): string[] {
  const emails = value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email))) {
    throw new Error("OWNER_EMAILS must contain comma-separated email addresses.");
  }
  return [...new Set(emails)];
}
