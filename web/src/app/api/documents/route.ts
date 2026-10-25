import { aiJobNinjaRoot, isRegularContainedFile } from "@/lib/aijobninja";
import { resolvePdfIndexPath } from "@/lib/core/pdf-index";
import { handleDocumentsRequest } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const root = aiJobNinjaRoot();
  const manifestPath = await resolvePdfIndexPath();
  return handleDocumentsRequest(req, root, manifestPath, isRegularContainedFile);
}
