/**
 * @file jwt.test.ts
 * @description Integration tests for JWT signing and verification.
 * The test cases cover different scenarios:
 * - Signing a JWT and verifying it successfully
 * - Signing a JWT and verifying it after expiration
 * - Verifying a invalid token
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import { signJwt } from "../../src/utils/jwt_tools/sign_jwt";
import {
  verifyJwt,
  type VerifiedToken,
} from "../../src/utils/jwt_tools/verify_jwt";

describe("JWT Integration: sign + verify", () => {
  it("should return { valid } for a valid token", () => {
    const payload = {user: { id: "user123", isAdmin: true }, type: "access"};
    const token = signJwt(payload, "5m");

    const result: VerifiedToken = verifyJwt(token);

    expect("valid" in result).to.be.true;
    if ("valid" in result) {
      const { user, type} = result.valid;
      expect(user?.id).to.equal("user123");
      expect(user?.isAdmin).to.equal(true);
    }
  });

  it("should return { expired } for an expired token", (done) => {
    const token = signJwt({ id: "expired_user", isAdmin: true }, "1ms");

    setTimeout(() => {
      const result: VerifiedToken = verifyJwt(token);
      expect("expired" in result).to.be.true;
      done();
    }, 2);
  });

  it("should return { invalid } for a malformed token", () => {
    const result: VerifiedToken = verifyJwt("not.a.valid.token");
    expect("invalid" in result).to.be.true;
  });
});
