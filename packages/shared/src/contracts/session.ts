import { z } from "zod";

export const userProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string(),
  role: z.enum(["USER", "ADMIN"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional()
});

export const authSessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  username: z.string(),
  nickname: z.string(),
  token: z.string(),
  createdAt: z.string().datetime()
});

export type UserProfile = z.infer<typeof userProfileSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
