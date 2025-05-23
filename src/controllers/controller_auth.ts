/**
 * @file controller_auth.ts
 * @description This file contains the controller for authentication-related operations.
 */

import { Response } from "express";
import prisma from "../db/prisma";
import {
  RegisterBody,
  LoginBody,
  ChangePasswordBody,
  RefreshTokenBody,
  JoinAdminBody,
  OAuthProviderParam,
  OAuthConsentQuery,
  AuthResponse,
  TokenRefreshResponse,
  DeviceIdBody,
  UserNameBody,
  OauthStateSchema,
  SetPasswordBody,
  DeviceIdQuery,
} from "../schema/schema_auth";
import { AuthRequest, User } from "../types/type_auth";
import { terminateWithErr } from "../utils/terminate_with_err";
import {
  generate_user_response,
  linkOauthAccount,
  loginOauthUser,
  registerUser,
  verifyUser,
} from "../service/auth/service_auth";
import { hashPassword, verifyPassword } from "../utils/crypto";
import {
  issueUserTokens,
  revokeRefreshToken,
  useRefreshToken,
} from "../service/auth/service_user_token";
import { signJwt } from "../utils/jwt_tools/sign_jwt";
import { verifyJwt } from "../utils/jwt_tools/verify_jwt";
import { OauthServiceMap } from "../service/oauth/oauth";
import { UserIdParam } from "../schema/schema_users";

/**
 * @summary Authentication Controller
 * @description This controller handles authentication-related operations:
 * - POST /auth/register register a new user
 * - POST /auth/login user login
 * - POST /auth/change-password user change password
 * - POST /auth/set-password set password for OAuth user
 * - PUT /auth/join-admin join admin
 * - POST /auth/refresh refresh access token
 * - POST /auth/logout logout
 * - GET /auth/username/:username check if username is available
 * - GET /auth/oauth/:provider oauth login
 * - GET /auth/oauth/:provider/callback oauth callback
 * - DELETE /auth/delete delete user
 * - DELETE /auth/oauth/unlink/:provider unlink oauth provider
 */
const authController = {
  /**
   * @summary Register a new user
   * @description POST /auth/register
   */
  async register(
    req: AuthRequest<unknown, RegisterBody>,
    res: Response<AuthResponse>
  ) {
    const { username, password, avatarUrl, consentAt, deviceId } =
      req.locals!.body!;

    // Call service to register user
    const user = await registerUser(
      consentAt,
      false,
      deviceId,
      username,
      password,
      avatarUrl
    );

    res.status(201).json(user);
  },

  /**
   * @summary User login
   * @description POST /auth/login
   * Only support non-OAuth users (OAuth users don't have password)
   */
  async login(
    req: AuthRequest<unknown, LoginBody>,
    res: Response<AuthResponse>
  ) {
    const { username, password, deviceId } = req.locals!.body!;

    // Check the user exists, may throw if use doesn't exist
    const user = await prisma.user.findUnique({
      where: { username },
      include: { oauthAccounts: { select: { provider: true } } },
    });

    if (
      !user || // User not found
      !user.encryptedPwd || // User is OAuth user
      user.deletedAt || // User is deleted
      (await verifyPassword(password, user.encryptedPwd!)) === false // Password mismatch
    )
      return terminateWithErr(401, "Invalid username or password");

    // Issue new tokens, for login we revoke only the current device's refresh token
    const tokens = await issueUserTokens(
      user.id,
      user.isAdmin,
      deviceId,
      false
    );

    res.status(200).json(generate_user_response(user, tokens));
  },

  /**
   * @summary Change user password
   * @description POST /auth/change-password
   */
  async changePassword(
    req: AuthRequest<unknown, ChangePasswordBody>,
    res: Response<AuthResponse>
  ) {
    const { currentPassword, password, deviceId } = req.locals!.body!;
    const { id: userId } = req.locals!.user!;

    // Check the user exists, may throw if use doesn't exist
    // We need to verify the current password here.
    const user = await verifyUser(userId, currentPassword);

    // Update the user password
    // Note: there is still a chance that the user is deleted during between
    // the findUnique and update calls, because we don't have a transaction here.
    // But this is a very low chance, and 500 is thrown in this case.
    const newUser = await prisma.user.update({
      where: { id: user.id },
      data: { encryptedPwd: await hashPassword(password) },
      include: { oauthAccounts: { select: { provider: true } } },
    });

    // Revoke all old tokens and issue new ones
    const tokens = await issueUserTokens(
      newUser.id,
      newUser.isAdmin,
      deviceId,
      true
    );

    // Return the response
    res.status(200).json(generate_user_response(newUser, tokens));
  },

  /**
   * @summary Set user password
   * @description POST /auth/set-password
   * This is used to set the password for a user who has no password (OAuth user).
   */
  async setPassword(
    req: AuthRequest<unknown, SetPasswordBody>,
    res: Response<AuthResponse>
  ) {
    const { password, deviceId } = req.locals!.body!;
    const { id: userId } = req.locals!.user!;

    // Check the user exists, may throw if use doesn't exist
    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null, encryptedPwd: null },
      include: { oauthAccounts: { select: { provider: true } } },
    });

    // If the user is not found, or already has a password, return 404
    if (!user)
      return terminateWithErr(404, "User not found, or already has password");

    // Update the user password
    const newUser = await prisma.user.update({
      where: { id: userId },
      data: { encryptedPwd: await hashPassword(password) },
      include: { oauthAccounts: { select: { provider: true } } },
    });

    // Revoke tokens for just this device and issue new ones
    const tokens = await issueUserTokens(
      newUser.id,
      newUser.isAdmin,
      deviceId,
      false
    );

    res.status(200).json(generate_user_response(newUser, tokens));
  },

  /**
   * @summary Join admin
   * @description PUT /auth/join-admin
   */
  async joinAdmin(
    req: AuthRequest<unknown, JoinAdminBody>,
    res: Response<AuthResponse>
  ) {
    const { referenceCode, deviceId } = req.locals!.body!;
    const { id: userId, isAdmin } = req.locals!.user!;

    // Check the reference code is valid
    if (referenceCode !== process.env.ADMIN_REF_CODE)
      return terminateWithErr(400, "Invalid reference code");

    // Check the user is already an admin
    if (isAdmin) return terminateWithErr(400, "Already an admin");

    // Update the user to admin
    let newUser = null;
    try {
      newUser = await prisma.user.update({
        where: { id: userId, deletedAt: null },
        data: { isAdmin: true },
        include: { oauthAccounts: { select: { provider: true } } },
      });
    } catch (err: any) {
      // If the user is not found, return 404
      if (err.code === "P2025") return terminateWithErr(404, "User not found");
      else throw err;
    }

    // Revoke all old tokens and issue new ones, because isAdmin is payload of token
    const tokens = await issueUserTokens(
      newUser.id,
      newUser.isAdmin,
      deviceId,
      true
    );

    res.status(200).json(generate_user_response(newUser, tokens));
  },

  /**
   * @summary Refresh access token
   * @description POST /auth/refresh
   */
  async refresh(
    req: AuthRequest<unknown, RefreshTokenBody>,
    res: Response<TokenRefreshResponse>
  ) {
    const { refreshToken, deviceId } = req.locals!.body!;

    // Use the refresh token, may throw if invalid
    const user = await useRefreshToken(refreshToken, deviceId);

    // Issue new tokens, for refresh we just revoke the old refresh token
    const tokens = await issueUserTokens(
      user.id,
      user.isAdmin,
      deviceId,
      false
    );

    res.status(200).json(tokens);
  },

  /**
   * @summary Logout user
   * @description POST /auth/logout
   * If the deviceId is not provided, all refresh tokens will be revoked.
   * Otherwise, only the refresh token of this device will be revoked.
   */
  async logout(req: AuthRequest<unknown, DeviceIdBody>, res: Response) {
    const { id: userId } = req.locals!.user!;
    const { deviceId } = req.locals!.body!;

    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) return terminateWithErr(404, "User not found");

    // revoke the refresh token
    await revokeRefreshToken(userId, deviceId ? deviceId : undefined);

    res.status(204).send();
  },

  /**
   * @summary Check if username is available
   * @description GET /auth/username/:username
   */
  async checkUsername(
    req: AuthRequest<UserNameBody>,
    res: Response<{ exists: boolean }>
  ) {
    const { username } = req.locals!.params!;

    // Check if the username exists
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    res.status(200).json({ exists: user !== null });
  },

  /**
   * @summary OAuth login
   * @description GET /auth/oauth/:provider
   * This will sign a JWT token as the state for keeping the userId, deviceId, consent, and csrf.
   */
  async oauthLogin(
    req: AuthRequest<OAuthProviderParam, unknown, OAuthConsentQuery>,
    res: Response
  ) {
    const { provider } = req.locals!.params!;
    const { consentAt, deviceId } = req.locals!.query!;
    const userId = req.locals!.user?.id;

    // Assemble the state
    const parsed = OauthStateSchema.safeParse({
      consentAt,
      deviceId,
      userId,
    });
    if (!parsed.success) {
      return terminateWithErr(400, "Invalid OAuth state parameters");
    }

    // Sign the state with JWT
    const payload = {
      state: parsed.data,
      type: "state",
    };

    const state = signJwt(payload, "15m");

    // Assemble the redirect URL
    const redirectUrl = OauthServiceMap[provider].getOauthUrl(state);

    // Redirect to the provider
    res.redirect(redirectUrl);
  },

  /**
   * @summary OAuth callback
   * @description GET /auth/oauth/:provider/callback
   * This will be called by the OAuth provider after the user has authorized the app.
   * The state is passed as a query parameter.
   */
  async oauthCallback(
    req: AuthRequest<OAuthProviderParam>,
    res: Response<AuthResponse>
  ) {
    try {
      const { provider } = req.locals!.params!;
      const { code, stateStr } = req.query;

      // If there is no provider, return 400
      if (!(provider in OauthServiceMap))
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_provider`
        );

      // If there is no state or state is invalid, return 400
      if (!stateStr || typeof stateStr !== "string")
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_state`
        );

      // If there is no code, return 400
      if (!code || typeof code !== "string")
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_code`
        );

      // Try to decode the state
      const decodedState = verifyJwt(stateStr);
      if ("expired" in decodedState || "invalid" in decodedState)
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_state`
        );
      if (!("valid" in decodedState))
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_state`
        );

      const { state: rawState, type } = decodedState.valid as {
        user?: User;
        state?: string;
        type: "access" | "refresh" | "state";
      };

      if (type !== "state")
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_state`
        );

      // Try to parse the state
      const parsedState = OauthStateSchema.safeParse(rawState!);
      if (!parsedState.success)
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_state`
        );

      // Extract the userId, deviceId, and consentAt from the state
      let userId = parsedState.data.userId;
      const { deviceId, consentAt } = parsedState.data;

      // To get the user info.
      const userInfo = await OauthServiceMap[provider].parseCallback(code);

      let response = null;

      // We do the link here.
      if (userId) response = await linkOauthAccount(userId, provider, userInfo);
      else {
        // We try to login now.
        userId = await loginOauthUser(provider, userInfo);

        if (!userId) {
          // Then we register the user, may throw if there is an error.
          response = await registerUser(
            consentAt,
            true,
            deviceId,
            "",
            "",
            userInfo.avatar,
            provider,
            userInfo.id
          );
        }
      }

      // Should not be here.
      if (!userId)
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth?error=invalid_user`
        );

      // We check the user, may throw if the user is deleted.
      const user = await verifyUser(userId, "", false);

      // Issue new tokens, for login we revoke only the current device's refresh token
      const tokens = await issueUserTokens(userId, false, deviceId, false);

      // Return the response
      res.redirect(
        `${process.env.FRONTEND_URL}/auth#accessToken=${tokens.accessToken}`
      );
    } catch (err: any) {
      // If there is an error, redirect to the frontend with the error message
      console.error(err);
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth?error=invalid_state`
      );
    }
  },

  /**
   * @summary Get user info
   * @description GET /auth/oauth/userinfo
   * This will be called by the frontend to get the user info after login.
   */
  async oauthUserGetInfo(
    req: AuthRequest<unknown, unknown, DeviceIdQuery>,
    res: Response<AuthResponse>
  ) {
    const { id: userId } = req.locals!.user!;
    const { deviceId } = req.locals!.query!;
    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      include: { oauthAccounts: { select: { provider: true } } },
    });
    if (!user) return terminateWithErr(404, "User not found");
    const tokens = await issueUserTokens(user.id, user.isAdmin, deviceId, true);
    res.status(200).json(generate_user_response(user, tokens));
  },

  /**
   * @summary Unlink OAuth account
   * @description DELETE /auth/oauth/unlink/:provider
   */
  async unlinkOauth(
    req: AuthRequest<OAuthProviderParam>,
    res: Response<{ message: string }>
  ) {
    const { provider } = req.locals!.params!;
    const { id: userId } = req.locals!.user!;

    // Delete it, it's an idempotent operation
    await prisma.oauthAccount.deleteMany({
      where: {
        userId,
        provider,
      },
    });

    res.status(204).send();
  },

  /**
   * @summary Delete user
   * @description DELETE /auth/delete
   * We apply soft delete here, so the user is not really deleted.
   */
  async deleteUser(req: AuthRequest<UserIdParam>, res: Response) {
    const { userId } = req.locals!.params!;

    // Double check the operation user id
    const { id } = req.locals!.user!;

    // A helper function to double check if the user is admin.
    const doubleCheck = async (): Promise<boolean> => {
      const exists = await prisma.user.findFirst({
        where: { id, deletedAt: null },
        select: { isAdmin: true },
      });
      return exists !== null && exists.isAdmin;
    };

    // Only admin or the user itself can delete
    if (id !== userId && !(await doubleCheck()))
      return terminateWithErr(
        403,
        "Forbidden: only admin or the user itself can delete"
      );

    // Check if the user exists, may throw if use doesn't exist
    const deleted = await prisma.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    // If the user is not found, return 404
    if (deleted.count === 0) return terminateWithErr(404, "User not found");

    // Also delete all the oauth accounts
    await prisma.oauthAccount.deleteMany({ where: { userId } });

    // Revoke all refresh tokens
    await revokeRefreshToken(userId);

    res.status(204).send();
  },
};

export default authController;
