import { nameOf, type User } from "./user.js";

export function greet(user: User): string {
  return `hello ${nameOf(user)}`;
}
