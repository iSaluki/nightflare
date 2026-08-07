import { Hono } from "hono";
import type { Env } from "../types";
import { foodCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const foodRoute = new Hono<{ Bindings: Env }>();

foodRoute.route("/", collectionRoute({ name: "food", getCollection: foodCollection, defaultLimit: 100 }));
