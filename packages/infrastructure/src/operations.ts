import { z } from "zod";
import { createDrive, type GoogleDriveStorage } from "./drive";
import type { AuthServices } from "./auth";
export const RootRequest = z
  .object({
    requestId: z.uuid(),
    revision: z.number().int().positive(),
    kind: z.enum(["register", "create"]),
    id: z.string().regex(/^[\w-]{1,200}$/),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.kind === "create" && !v.name)
      c.addIssue({ code: "custom", message: "Cần tên thư mục mới" });
  });
export async function configureRoot(
  services: AuthServices,
  actor: string,
  input: unknown,
  env: NodeJS.ProcessEnv,
  factory: (
    env: NodeJS.ProcessEnv,
  ) => Pick<GoogleDriveStorage, "checkRoot" | "folder"> = createDrive,
) {
  const value = RootRequest.parse(input);
  const receipt = (await services.rpc("app_operations", {
    actor,
    operation: "root-prepare",
    input: value,
  })) as { repeated: boolean; revision: number; rootId?: string };
  if (receipt.repeated) return { rootId: receipt.rootId, repeated: true };
  try {
    const drive = factory({ ...env, DRIVE_ROOT_ID: value.id });
    await drive.checkRoot(true);
    const rootId =
      value.kind === "create"
        ? await drive.folder(value.id, value.name!)
        : value.id;
    await factory({ ...env, DRIVE_ROOT_ID: rootId }).checkRoot(true);
    return (await services.rpc("app_operations", {
      actor,
      operation: "root-finish",
      input: {
        requestId: value.requestId,
        revision: receipt.revision,
        rootId,
        existingServerRoot: env.DRIVE_ROOT_ID || "",
      },
    })) as { rootId: string; repeated: boolean };
  } catch (error) {
    try {
      await services.rpc("app_operations", {
        actor,
        operation: "root-uncertain",
        input: { requestId: value.requestId },
      });
    } catch {
      /* Keep pending receipt; never repeat an ambiguous create automatically. */
    }
    throw error;
  }
}
