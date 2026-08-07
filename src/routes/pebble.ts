import { Hono } from "hono";
import type { Env } from "../types";
import { entriesCollection } from "../db";

// Legacy Pebble watchface endpoint some watch/widget apps still poll.
export const pebbleRoute = new Hono<{ Bindings: Env }>();

const DIRECTIONS: Record<string, number> = {
  NONE: 0,
  DoubleUp: 1,
  SingleUp: 2,
  FortyFiveUp: 3,
  Flat: 4,
  FortyFiveDown: 5,
  SingleDown: 6,
  DoubleDown: 7,
  "NOT COMPUTABLE": 8,
  RATE_OUT_OF_RANGE: 9,
};

pebbleRoute.get("/", async (c) => {
  const params = new URLSearchParams();
  params.set("find[type]", "sgv");
  params.set("count", "10");
  const docs = await entriesCollection(c.env.DB).list(params, { defaultLimit: 10 });

  const bgs = docs.map((d) => ({
    sgv: String(d.sgv ?? ""),
    trend: DIRECTIONS[(d.direction as string) ?? "NONE"] ?? 0,
    direction: (d.direction as string) ?? "NONE",
    datetime: d.date,
    filtered: d.filtered ?? null,
    unfiltered: d.unfiltered ?? null,
    noise: d.noise ?? 1,
    battery: "",
  }));

  return c.json({ status: [{ now: Date.now() }], bgs, cals: [] });
});
