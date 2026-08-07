import fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { AppConfig } from "./config";
import { openDb } from "./db/db";
import { migrate } from "./db/migrate";
import { ensureBootstrapUser } from "./auth/bootstrap";
import { seedDevUsers } from "./auth/devSeed";
import { registerAuthRoutes } from "./auth/routes";
import { registerVenueRoutes } from "./venues/routes";
import { BlobStore } from "./blobs/store";
import { JobQueue } from "./jobs/queue";
import { makePublishRunner } from "./jobs/publish";
import { registerJobRoutes } from "./jobs/routes";
import { registerUploadRoute } from "./venues/uploadRoute";
import { GDB_MAX_UPLOAD_BYTES } from "./gdb/sourceValidation";
import { registerTileRoutes } from "./tiles/routes";
import { registerGdbRoutes } from "./gdb/routes";
import { registerServeRoutes } from "./serve/routes";
import { recompileLegacyPublished } from "./core/recompileLegacy";
import { AnchorIndexCache } from "./issues/anchorIndex";
import { runIssueAttachmentJanitor } from "./issues/attachments/janitor";
import { issueAttachmentRoutes } from "./issues/attachments/routes";
import { IssueAttachmentService } from "./issues/attachments/service";
import { IssueAttachmentStore } from "./issues/attachments/store";
import { IssueEventHub } from "./issues/events";
import { IssueRepository } from "./issues/repository";
import { issueRoutes } from "./issues/routes";
import { IssueService } from "./issues/service";
import { UTC_TIMESTAMP_FORMAT } from "./issues/schemas";
import { isRfc3339UtcTimestamp } from "./issues/validation";

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const db = openDb(config.dataDir);
  migrate(db);

  const app = fastify({
    logger: { level: process.env["NODE_ENV"] === "test" ? "warn" : "info" },
    ajv: {
      customOptions: { removeAdditional: false },
      onCreate: (ajv) => {
        ajv.addFormat(UTC_TIMESTAMP_FORMAT, isRfc3339UtcTimestamp);
      },
    },
    serializerOpts: {
      ajv: { formats: { [UTC_TIMESTAMP_FORMAT]: isRfc3339UtcTimestamp } },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate("db", db);
  app.decorate("config", config);
  const blobs = new BlobStore(config.dataDir);
  app.decorate("blobs", blobs);

  // Recompile Phase One source aliases into real .kvb bundles before the
  // queue or any route accepts traffic; a half-migrated row must never be
  // served under the bundle MIME type.
  try {
    await recompileLegacyPublished(db, blobs, (message) => app.log.error(message));
  } catch (error) {
    db.close();
    throw error;
  }

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: GDB_MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(swagger, {
    openapi: { info: { title: "Kiriko API", version: "0.1.0" } },
  });

  const queueOptions = config.jobShutdownGraceMs === undefined ? {} : { closeGraceMs: config.jobShutdownGraceMs };
  const queue = new JobQueue(db, { publish_imdf: makePublishRunner(db, app.blobs) }, queueOptions);
  app.decorate("queue", queue);

  const issueRepository = new IssueRepository(db);
  const anchorIndexCache = new AnchorIndexCache(blobs);
  const issueHub = new IssueEventHub({
    maxConnections: config.issueSseMaxConnections,
    maxPerVersion: config.issueSseMaxPerVersion,
  });
  const issueService = new IssueService(issueRepository, anchorIndexCache, issueHub);

  const issueAttachmentStore = new IssueAttachmentStore(config.dataDir);
  const issueAttachmentService = new IssueAttachmentService({
    db,
    store: issueAttachmentStore,
    versions: issueRepository,
    versionQuotaBytes: config.issueAttachmentVersionQuotaBytes ?? 512 * 1024 * 1024,
    uploadRateMax: config.issueAttachmentUploadRateMax ?? 30,
    uploadRateWindowMs: 10 * 60 * 1000,
    processingConcurrency: 2,
  });

  // Startup janitor pass (plus a periodic timer below): expired staged
  // uploads, detached/tombstoned media, and filesystem/SQLite crash gaps.
  try {
    runIssueAttachmentJanitor(db, issueAttachmentStore);
  } catch (error) {
    app.log.error(error, "issue attachment janitor failed at startup");
  }
  const issueAttachmentJanitorTimer = setInterval(() => {
    try {
      runIssueAttachmentJanitor(db, issueAttachmentStore);
    } catch (error) {
      app.log.error(error, "issue attachment janitor failed");
    }
  }, config.issueAttachmentJanitorIntervalMs ?? 3_600_000);
  issueAttachmentJanitorTimer.unref();

  ensureBootstrapUser(db, config);
  seedDevUsers(db, config, (message) => app.log.warn(message));
  registerAuthRoutes(app);
  registerVenueRoutes(app, issueHub);
  registerUploadRoute(app);
  registerGdbRoutes(app);
  registerTileRoutes(app);
  registerJobRoutes(app);
  registerServeRoutes(app);
  await app.register(issueRoutes, {
    service: issueService,
    repository: issueRepository,
    hub: issueHub,
  });
  await app.register(issueAttachmentRoutes, { service: issueAttachmentService });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/openapi.json", async () => app.swagger());

  app.addHook("preClose", async () => {
    issueHub.close();
    await queue.close();
  });

  app.addHook("onClose", async () => {
    clearInterval(issueAttachmentJanitorTimer);
    anchorIndexCache.clear();
    db.close();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: import("better-sqlite3").Database;
    config: AppConfig;
    blobs: BlobStore;
    queue: JobQueue;
  }
}
