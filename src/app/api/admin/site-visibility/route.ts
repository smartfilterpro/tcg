import { NextResponse } from "next/server";
import { requireAdmin, AuthError } from "@/lib/auth";
import { isSiteIndexable, setSiteIndexable } from "@/lib/siteFlags";
import { errorJson } from "@/lib/apiError";

/** The launch button: whether search engines may crawl and index the site.
 *  One flag drives both signals (/robots.txt and the meta noindex on every
 *  page), so they can never disagree. Admin-only — this is an owner
 *  decision, and requireAdmin (not moderator) matches that. */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ indexable: await isSiteIndexable() });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as { indexable?: boolean };
    if (typeof body.indexable !== "boolean") {
      return NextResponse.json({ error: "indexable must be true or false" }, { status: 400 });
    }
    await setSiteIndexable(body.indexable);
    return NextResponse.json({ indexable: body.indexable });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorJson(err, "Request failed");
  }
}
