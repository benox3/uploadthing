/**
 * The `import type * as _MAKE_TS_AWARE_1 from` are imported to make TypeScript aware of the types.
 * It's having a hard time resolving deeply nested stuff from transitive dependencies.
 * You'll notice if you need to add more imports if you get build errors like:
 * `The type of X cannot be inferred without a reference to <MODULE>`
 */
import type * as _MAKE_TS_AWARE_1 from "@effect/schema/ParseResult";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";

import {
  exponentialBackoff,
  fetchEff,
  fetchEffJson,
  FileData,
  generateUploadThingURL,
  RetryError,
  UploadThingError,
} from "@uploadthing/shared";
import type { ResponseEsque } from "@uploadthing/shared";

import { logger } from "./logger";

const isValidResponse = (response: ResponseEsque) => {
  if (!response.ok) return false;
  if (response.status >= 400) return false;
  if (!response.headers.has("x-uploadthing-version")) return false;

  return true;
};

export const conditionalDevServer = (fileKey: string) => {
  return Effect.gen(function* ($) {
    const file = yield* $(
      fetchEffJson(
        generateUploadThingURL(`/api/pollUpload/${fileKey}`),
        S.struct({
          status: S.string,
          fileData: S.optional(FileData),
        }),
      ),
      Effect.andThen((res) =>
        res.status === "done"
          ? Effect.succeed(res.fileData)
          : Effect.fail(new RetryError()),
      ),
      Effect.retry({
        while: (err) => err instanceof RetryError,
        schedule: exponentialBackoff,
      }),
      Effect.catchTag("RetryError", (e) => Effect.die(e)),
    );

    if (file === undefined) {
      logger.error(`Failed to simulate callback for file ${fileKey}`);
      return yield* $(
        new UploadThingError({
          code: "UPLOAD_FAILED",
          message: "File took too long to upload",
        }),
      );
    }

    let callbackUrl = file.callbackUrl + `?slug=${file.callbackSlug}`;
    if (!callbackUrl.startsWith("http")) callbackUrl = "http://" + callbackUrl;

    logger.info("SIMULATING FILE UPLOAD WEBHOOK CALLBACK", callbackUrl);

    const callbackResponse = yield* $(
      fetchEff(callbackUrl, {
        method: "POST",
        body: JSON.stringify({
          status: "uploaded",
          metadata: JSON.parse(file.metadata ?? "{}") as FileData["metadata"],
          file: {
            url: `https://utfs.io/f/${encodeURIComponent(fileKey)}`,
            key: fileKey,
            name: file.fileName,
            size: file.fileSize,
            customId: file.customId,
          },
        }),
        headers: {
          "uploadthing-hook": "callback",
        },
      }),
      Effect.catchTag("FetchError", () =>
        Effect.succeed(new Response(null, { status: 500 })),
      ),
    );

    if (isValidResponse(callbackResponse)) {
      logger.success("Successfully simulated callback for file", fileKey);
    } else {
      logger.error(
        `Failed to simulate callback for file '${file.fileKey}'. Is your webhook configured correctly?`,
      );
      logger.error(
        `  - Make sure the URL '${callbackUrl}' is accessible without any authentication. You can verify this by running 'curl -X POST ${callbackUrl}' in your terminal`,
      );
      logger.error(
        `  - Still facing issues? Read https://docs.uploadthing.com/faq for common issues`,
      );
    }
    return file;
  });
};
