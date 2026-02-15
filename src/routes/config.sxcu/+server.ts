import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
    const origin = url.origin;
    const useExt = url.searchParams.get("ext") === "true";
    const skipCd = url.searchParams.get("skip-cd") === "true";
    const token = url.searchParams.get("token");

    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const deleteQuery = token ? `&token=${encodeURIComponent(token)}` : "";
    const downloadQuery = skipCd ? "?skip-cd=true" : "";

    const config = {
        Version: "13.7.0",
        Name: "Uploader",
        DestinationType: "ImageUploader",
        RequestType: "POST",
        RequestURL: `${origin}/api/upload${query}`,
        FileFormName: "file",
        Body: "MultipartFormData",
        URL: `${origin}/{json:id}${useExt ? "{json:ext}" : ""}${downloadQuery}`,
        DeletionURL: `${origin}/api/delete?key={json:key}${deleteQuery}`,
        DeletionMethod: "POST",
    };

    return new Response(JSON.stringify(config, null, 4), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": 'attachment; filename="uploader.sxcu"',
        },
    });
};
