export interface User {
  readonly id: string;
  readonly name: string;
}

export function nameOf(user: User): string {
  return user.name;
}
