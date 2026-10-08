import { version } from "../../../package.json";
export const releaseContract = {
  version,
  contractVersion: 1,
  minimumMigration: "202610090023_operations_receipts.sql",
} as const;

declare const __BOOK_RELEASE_REVISION__: string | null;
export const releaseRevision =
  typeof __BOOK_RELEASE_REVISION__ === "undefined"
    ? null
    : __BOOK_RELEASE_REVISION__;
