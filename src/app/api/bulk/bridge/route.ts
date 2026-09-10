import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

// The Pi bridge's distribution point: the deployment that people scan
// against is also where the bench appliance gets its updates. The Pi's
// page has a "check for update" that fetches this, compares versions,
// and installs — so a merge-and-deploy here reaches the bench without
// anyone SSHing into the Pi. Public on purpose: the script holds no
// secrets (keys live in the Pi's own config file), and the fetch happens
// before any key could prove itself anyway.
export async function GET() {
  try {
    const file = path.join(process.cwd(), "scripts", "pi-bridge.mjs");
    const text = await readFile(file, "utf8");
    const version = /const BRIDGE_VERSION = "([^"]+)"/.exec(text)?.[1] ?? "unknown";
    return new NextResponse(text, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "x-bridge-version": version,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "The bridge script isn't part of this deployment." },
      { status: 404 }
    );
  }
}
