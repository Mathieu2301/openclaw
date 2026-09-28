import type { UserProfile, UsersSelfResult } from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { userProfileAvatarUrl } from "../pages/profile/profile-avatar-url.ts";
import type { ApplicationGatewayConnection, ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorSelfReadAccess } from "./operator-access.ts";
import { sameSelfUser, type AuthenticatedUser } from "./user-profile.ts";

export function createGatewaySelfProfile(options: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  getConnection: () => ApplicationGatewayConnection;
  publish: (selfUser: AuthenticatedUser | null) => void;
  resourceBasePath?: string;
}) {
  let selfProfileRequest: Promise<UserProfile | null> | null = null;
  const loadSelfProfile = (): Promise<UserProfile | null> => {
    const requestClient = options.getSnapshot().client;
    const hello = options.getSnapshot().hello;
    if (
      !requestClient ||
      !hello ||
      options.getSnapshot().phase !== "connected" ||
      !hasOperatorSelfReadAccess(hello.auth ?? null)
    ) {
      return Promise.resolve(null);
    }
    if (selfProfileRequest) {
      return selfProfileRequest;
    }
    const isCurrent = () =>
      options.getSnapshot().client === requestClient &&
      options.getSnapshot().hello === hello &&
      options.getSnapshot().phase === "connected" &&
      selfProfileRequest === request;
    const request = requestClient
      .request<UsersSelfResult>("users.self", {})
      .then(({ profile }) => {
        if (!isCurrent()) {
          return null;
        }
        const selfUser = {
          id: profile.id,
          identity: { type: "profile" as const, id: profile.id },
          name: profile.displayName ?? undefined,
          email: profile.emails[0],
          avatarUrl:
            userProfileAvatarUrl(
              options.getConnection().gatewayUrl,
              profile.id,
              profile.updatedAt,
              options.resourceBasePath,
            ) ?? undefined,
        };
        if (!sameSelfUser(options.getSnapshot().selfUser, selfUser)) {
          options.publish(selfUser);
        }
        // Publishing identity can synchronously stop or replace the connection.
        return isCurrent() ? profile : null;
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return null;
        }
        if (error instanceof GatewayRequestError && error.code === "FORBIDDEN") {
          options.publish(null);
          return null;
        }
        throw error;
      })
      .finally(() => {
        if (selfProfileRequest === request) {
          selfProfileRequest = null;
        }
      });
    selfProfileRequest = request;
    return request;
  };
  return {
    load: loadSelfProfile,
    invalidate: () => {
      selfProfileRequest = null;
    },
  };
}
