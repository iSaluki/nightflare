import { Hono } from "hono";
import type { Env } from "../types";
import { treatmentsCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const treatmentsRoute = new Hono<{ Bindings: Env }>();

treatmentsRoute.route(
  "/",
  collectionRoute({ name: "treatments", getCollection: treatmentsCollection, defaultLimit: 100, allowBulkInsert: true })
);
