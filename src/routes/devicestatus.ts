import { Hono } from "hono";
import type { Env } from "../types";
import { devicestatusCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const devicestatusRoute = new Hono<{ Bindings: Env }>();

devicestatusRoute.route(
  "/",
  collectionRoute({ name: "devicestatus", getCollection: devicestatusCollection, defaultLimit: 10, allowBulkInsert: true })
);
