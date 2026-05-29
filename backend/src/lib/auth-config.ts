// Whitelisted emails that can access the portal
export const ALLOWED_EMAILS = [
  "rutujamanework08@gmail.com",
  "shaivinparikh@gmail.com",
  "nikhil13072003@gmail.com",
  "viratsy512@gmail.com",
  "viratsy51@gmail.com",
  "amitrawoolwork@gmail.com",
  "tusharsmhadlekar123@gmail.com",
];

export function isEmailAllowed(email: string): boolean {
  return ALLOWED_EMAILS.includes(email.toLowerCase().trim());
}
