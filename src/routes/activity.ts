import { Hono } from "hono";
import type { Env } from "../types";
import { activityCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const activityRoute = new Hono<{ Bindings: Env }>();

activityRoute.route("/", collectionRoute({ name: "activity", getCollection: activityCollection, defaultLimit: 50 }));
