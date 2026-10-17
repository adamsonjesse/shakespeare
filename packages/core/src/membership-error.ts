export type MembershipErrorCode =
  | "malformed"
  | "expired"
  | "bad-signature"
  | "used"
  | "wrong-club"
  | "already-member"
  | "empty-name"
  | "exists";

const MESSAGES: Record<MembershipErrorCode, string> = {
  malformed: "The invite is malformed.",
  expired: "The invite is expired.",
  "bad-signature": "The invite signature is invalid.",
  used: "The invite was already used.",
  "wrong-club": "The invite does not match this club.",
  "already-member": "That profile is already a member.",
  "empty-name": "The club name is empty.",
  exists: "The club already exists.",
};

export class MembershipError extends Error {
  readonly code: MembershipErrorCode;

  constructor(code: MembershipErrorCode) {
    super(MESSAGES[code]);
    this.name = "MembershipError";
    this.code = code;
  }
}
