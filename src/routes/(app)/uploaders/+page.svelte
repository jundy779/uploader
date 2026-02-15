<script>
    import { browser } from "$app/environment";
    import { page } from "$app/stores";
    import { userSettings } from "$lib/userSettings";

    const url = $page.url.origin;

    let sharexConfigURL = new URL(`${url}/config.sxcu`);

    const endpoints = {
        upload: `${url}/api/upload`,
        delete: `${url}/api/delete`,
        object: `${url}/api/object`,
    };

    $: {
        if ($userSettings.fileContentDisposition) {
            sharexConfigURL.searchParams.delete("skip-cd");
        } else {
            sharexConfigURL.searchParams.set("skip-cd", "true");
        }

        if ($userSettings.appendFileExt) {
            sharexConfigURL.searchParams.set("ext", "true");
        } else {
            sharexConfigURL.searchParams.delete("ext");
        }
        sharexConfigURL = sharexConfigURL;
    }
</script>

<div>
    <details open>
        <summary>ShareX</summary>
        {#if browser}
            <p>
                <a
                    href={sharexConfigURL.toString()}
                    data-umami-event="sharex-download">Click here</a
                > to download the ShareX 11.5+ config
            </p>
        {/if}
    </details>
</div>

<div>
    <details open>
        <summary>Chatterino</summary>
        <div>
            <p>Settings; External Tools; Image Uploader</p>

            <table>
                <tr>
                    <th>Request URL:</th>
                    <td
                        >{endpoints.upload}{!$userSettings.fileContentDisposition
                            ? "?skip-cd=true"
                            : ""}</td
                    >
                </tr>
                <tr>
                    <th>Form field:</th>
                    <td>file</td>
                </tr>
                <tr>
                    <th>Image link:</th>
                    <td
                        >{`{link}${$userSettings.appendFileExt ? "{ext}" : ""}`}</td
                    >
                </tr>
                <tr>
                    <th>Deletion link:</th>
                    <td>{"{delete}"}</td>
                </tr>
            </table>
        </div>
    </details>
</div>

<div>
    <details>
        <summary>
            <a
                target="_blank"
                href="https://play.google.com/store/apps/details?id=com.flxrs.dankchat&ref=segs.lol"
                data-umami-event="dankchat-link">DankChat</a
            >
        </summary>
        <p>
            Native Twitch chat client for mobile -- <br />Same configuration
            format as Chatterino, uploader defaults to
            <a target="_blank" href="https://kappa.lol/">kappa.lol</a>.
        </p>
    </details>
</div>

<div>
    <details open>
        <summary>CLI</summary>
        <div class="r">
            <div>Bash</div>
            <pre>curl "{endpoints.upload}" -F "file=@/path/to/file.png"</pre>
        </div>
        <div class="r">
            <div>PowerShell</div>
            <pre>curl "{endpoints.upload}" -F "file=@C:\path\to\file.png"</pre>
        </div>
    </details>
</div>

<div>
    <details>
        <summary>API</summary>
        <div class="api-block">
            <div class="api-title">Upload</div>
            <pre class="codeblock">curl "{endpoints.upload}" -F "file=@/home/supa/kappa.png"</pre>
            <div class="api-subtitle">Response</div>
            <pre class="codeblock">content-type: application/json</pre>
            <pre class="codeblock">{JSON.stringify(
                    {
                        id: "${id}",
                        ext: ".png",
                        type: "image/png",
                        checksum: "${md5}",
                        key: "${key}",
                        origin: $page.url.origin,
                        private: false,
                        link: `${$page.url.origin}/\${id}`,
                        delete: `${$page.url.origin}/delete?\${key}`,
                    },
                    null,
                    4,
                )}</pre>
        </div>
        <div class="api-block">
            <div class="api-title">SDK examples</div>
            <div class="api-grid">
                <div class="api-card">
                    <div class="api-subtitle">Node.js (fetch)</div>
                    <pre class="codeblock">{`import fs from "node:fs";
import FormData from "form-data";

const filePath = "/path/to/file.png";
const form = new FormData();
form.append("file", fs.createReadStream(filePath));

const res = await fetch("${endpoints.upload}", {
  method: "POST",
  headers: { Authorization: "Bearer {token}" },
  body: form
});
console.log(await res.json());`}</pre>
                </div>
                <div class="api-card">
                    <div class="api-subtitle">Python (requests)</div>
                    <pre class="codeblock">{`import requests

file_path = "/path/to/file.png"
with open(file_path, "rb") as f:
    res = requests.post(
        "${endpoints.upload}",
        headers={"Authorization": "Bearer {token}"},
        files={"file": f},
    )
print(res.json())`}</pre>
                </div>
                <div class="api-card">
                    <div class="api-subtitle">PHP (cURL)</div>
                    <pre class="codeblock">{`<?php
$file = new CURLFile("/path/to/file.png");
$ch = curl_init("${endpoints.upload}");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ["Authorization: Bearer {token}"],
  CURLOPT_POSTFIELDS => ["file" => $file],
  CURLOPT_RETURNTRANSFER => true,
]);
$response = curl_exec($ch);
curl_close($ch);
echo $response;`}</pre>
                </div>
            </div>
        </div>
        <div class="api-block">
            <div class="api-title">Auth</div>
            <pre class="codeblock">Authorization: Bearer {"{token}"}</pre>
            <pre class="codeblock">X-API-Key: {"{token}"}</pre>
            <pre class="codeblock">{endpoints.upload}?token={"{token}"}</pre>
        </div>
        <div class="api-block">
            <div class="api-title">Private upload</div>
            <pre class="codeblock">curl "{endpoints.upload}" -F "file=@/path/to/file.png" -F "visibility=private" -F "password=secret"</pre>
            <div class="api-subtitle">Access</div>
            <pre class="codeblock">{$page.url.origin}/{"{id}"}?pw=secret</pre>
            <pre class="codeblock">X-File-Password: secret</pre>
        </div>
        <div class="api-block">
            <div class="api-title">Delete</div>
            <pre class="codeblock">curl "{endpoints.delete}?key=$fileKey"</pre>
            <div class="api-subtitle">Response</div>
            <pre class="codeblock">content-type: application/json</pre>
            <pre class="codeblock">{JSON.stringify({ success: true }, null, 4)}</pre>
        </div>
        <div class="api-block">
            <div class="api-title">Object</div>
            <pre class="codeblock">curl "{endpoints.object}?id=$fileId"</pre>
            <div class="api-subtitle">Response</div>
            <pre class="codeblock">content-type: application/json</pre>
            <pre class="codeblock">{JSON.stringify(
                    {
                        id: "${id}",
                        type: "${mimetype}",
                        date: "${Number(unixUploadTimeMS)}",
                        size: "${Number(bytes)}",
                        checksums: { md5: "${md5}" },
                        name: "${filename} (nullable)",
                    },
                    null,
                    4,
                )}</pre>
        </div>
        <div class="api-block">
            <div class="api-title">Download options</div>
            <pre class="codeblock">{$page.url.origin}/{"{id}"}?skip-cd=true</pre>
        </div>
        <div class="api-block">
            <div class="api-title">Limits & Errors</div>
            <div class="api-pair">
                <div class="api-label">Rate limits</div>
                <div>Upload 20/min, Delete 60/min, Object 120/min</div>
            </div>
            <div class="api-pair">
                <div class="api-label">Errors</div>
                <div>
                    400 bad request, 401 unauthorized, 403 forbidden, 404 not found,
                    413 file too large, 429 too many requests, 500 server error
                </div>
            </div>
        </div>
    </details>
</div>

<div>
    <p>
        Looking for a cool song/video queue manager for your Twitch chat?<br
        />Either way, check out
        <a
            href="https://chat.vote/playlist/?ref=segs.lol"
            target="_blank"
            data-umami-event="badoge-playlist-link">chat.vote/playlist</a
        >!
    </p>
</div>

<style>
    summary {
        margin-top: 10px;
        margin-bottom: 0;
        font-weight: 500;
        font-size: 2em;
        cursor: pointer;
    }

    details p {
        margin-top: 0;
    }

    .r {
        border-left: 1px solid rgb(var(--fg));
        padding: 0 10px;
        margin: 5px;
    }

    .api-block {
        margin: 10px 0;
        padding: 10px;
        border: 1px solid rgb(var(--outl2));
        border-radius: 8px;
        background: rgb(var(--bg_h));
    }

    .api-title {
        font-size: 1.1em;
        font-weight: 600;
        margin-bottom: 6px;
    }

    .api-subtitle {
        font-size: 0.95em;
        font-weight: 600;
        margin: 8px 0 4px;
    }

    .api-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 8px;
    }

    .api-card {
        padding: 8px;
        border: 1px solid rgb(var(--outl1));
        background: rgb(var(--bg0));
        border-radius: 6px;
    }

    .codeblock {
        font-family: monospace;
        background-color: rgb(var(--bg0));
        border: 1px solid rgb(var(--outl1));
        border-radius: 6px;
        padding: 6px 8px;
        margin: 4px 0;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .api-pair {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 8px;
        align-items: start;
        margin-top: 6px;
    }

    .api-label {
        font-weight: 600;
    }
</style>
