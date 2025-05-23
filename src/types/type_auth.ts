/**
 * @file type_auth.ts
 * @description The type definitions for authentication.
 */

import { Request } from "express";
import { ParamsDictionary } from "express-serve-static-core";
import { ParsedQs } from "qs";

/**
 * @description The user type.
 * @property {string} id - The unique identifier for the user.
 * @property {boolean} isAdmin - Indicates if the user is an admin.
 */
type User = {
  id: string;
  isAdmin: boolean;
};

/**
 * @description The request type for authentication.
 */
interface AuthRequest<P = unknown, B = unknown, Q = unknown>
  extends Request<any, any, any, any> {
  locals?: {
    user?: User;
    params?: P;
    body?: B;
    query?: Q;
  };
}

/**
 * @summary the type of the verified token
 * @description The verified token can be one of the following:
 * - valid: payload.
 * - expired: undefined.
 * - invalid: undefined.
 */
type VerifiedToken =
  | {
      valid: {
        user?: User;
        state?: string;
        type: "access" | "refresh" | "state";
      };
    }
  | { expired: undefined }
  | { invalid: undefined };

export type { AuthRequest, User, VerifiedToken };
