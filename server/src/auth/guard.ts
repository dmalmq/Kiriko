import type { FastifyReply, FastifyRequest } from "fastify";
import { sessionUser, type SessionUser } from "./sessions";

export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies["kiriko_session"];
  const user = token ? sessionUser(request.server.db, token) : null;
  if (user === null) {
    await reply.code(401).send({ error: "unauthorized", message: "Authentication is required." });
    return;
  }
  request.user = user;
}

export async function requireProducerSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies["kiriko_session"];
  const user = token ? sessionUser(request.server.db, token) : null;
  if (user === null) {
    await reply.code(401).send({
      error: "unauthorized",
      code: "unauthorized",
      message: "Authentication is required.",
    });
    return;
  }
  if (user.role === "viewer") {
    await reply.code(403).send({
      error: "forbidden",
      code: "forbidden",
      message: "Only members and admins can edit network data.",
    });
    return;
  }
  request.user = user;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser;
  }
}
