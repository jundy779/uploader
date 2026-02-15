<script>
    import { userSettings } from "$lib/userSettings";
    import { onDestroy, onMount, tick } from "svelte";
    import Dialog from "./Dialog.svelte";
    import { uploadedFiles, saveFiles, loadFiles } from "./files";
    import Icon from "./Icon.svelte";

    const apiBase = import.meta.env.VITE_API_BASE_URL || "";
    const apiToken = import.meta.env.VITE_API_TOKEN || "";

    /** @type {Boolean} */
    export let isNewUpload;

    /** @type {import('$lib/types.js').File} */
    export let file;

    /** @type {HTMLDialogElement} */
    let deleteDialog;

    /** @type {HTMLInputElement} */
    let urlInput;

    /** @type {(msg: string) => void} */
    export let notifyError;

    let fileUrl = "";
    let thumbUrl = "";
    let qrUrl = "";

    /** @type {HTMLDialogElement} */
    let qrDialog;
    /** @type {number | null} */
    let cleanupTimer = null;

    const copy = () => {
        const val = urlInput.value;
        urlInput.select();
        urlInput.setSelectionRange(0, val.length);
        navigator.clipboard.writeText(val);
    };

    const openQr = () => {
        qrDialog.showModal();
    };

    const deleteFile = () => {
        deleteDialog.showModal();
    };

    const dialogOnClose = async () => {
        if (deleteDialog.returnValue === "confirm") {
            deleteDialog.returnValue = "";
            try {
                const deleteUrl = new URL(
                    "/api/delete",
                    apiBase || window.location.origin,
                );
                deleteUrl.searchParams.set("key", file.key);
                if (apiToken) {
                    deleteUrl.searchParams.set("token", apiToken);
                }
                const res = await fetch(deleteUrl.toString(), { method: "POST" });

                if (res.status == 503) {
                    notifyError(`Failed deleting "${file.name}": maintenance`);
                    return
                }

                const data = await res.json();

                if (res.status == 200 || res.status == 400) {
                    loadFiles();
                    uploadedFiles.update((arr) => {
                        return arr.filter((x) => x.id !== file.id);
                    });
                    saveFiles();
                }

                if (!data.success) throw data.message ?? JSON.stringify(data, null, 4);
            } catch (err) {
                notifyError(`Failed deleting "${file.name}":\n${err}`);
            }
        }
    };

    const removeFromHistory = () => {
        loadFiles();
        uploadedFiles.update((arr) => {
            return arr.filter((x) => x.id !== file.id);
        });
        saveFiles();
    };

    const checkExists = async () => {
        try {
            const checkUrl = new URL(
                "/api/object",
                apiBase || window.location.origin,
            );
            checkUrl.searchParams.set("id", file.id);
            if (apiToken) {
                checkUrl.searchParams.set("token", apiToken);
            }
            const res = await fetch(checkUrl.toString());
            if (res.status === 404) {
                removeFromHistory();
            }
        } catch (_) {}
    };

    $: {
        const base = new URL(
            `/${file.id}${$userSettings.appendFileExt ? file.ext : ""}`,
            file.origin || window.location.origin,
        );
        if (!$userSettings.fileContentDisposition) {
            base.searchParams.set("skip-cd", "true");
        }
        if (file.private && file.password) {
            base.searchParams.set("pw", file.password);
        }
        fileUrl = base.toString();
        const thumb = new URL(`/t/${file.id}`, file.origin || window.location.origin);
        if (file.private && file.password) {
            thumb.searchParams.set("pw", file.password);
        }
        thumbUrl = thumb.toString();
        qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(fileUrl)}`;
    }

    onMount(async () => {
        if (isNewUpload) {
            urlInput.focus();
        }
        deleteDialog.addEventListener("close", dialogOnClose);
        cleanupTimer = window.setTimeout(checkExists, 600);
    });

    onDestroy(() => {
        deleteDialog.removeEventListener("close", dialogOnClose);
        if (cleanupTimer) {
            clearTimeout(cleanupTimer);
        }
    });
</script>

<Dialog bind:node={deleteDialog}>
    <div class="delete-dialog">
        <p>Are you sure you want to delete <span class="highlight">{file.name}</span>?</p>
        <div class="option">
            <button on:click={() => deleteDialog.close("confirm")} class="alert">Yes</button>
            <button on:click={() => deleteDialog.close("cancel")} class="ok">No</button>
        </div>
    </div>
</Dialog>

<Dialog bind:node={qrDialog}>
    <div class="qr-dialog">
        <div class="qr-title">QR Code</div>
        <img class="qr-image" alt="QR code" src={qrUrl} />
        <div class="qr-link">{fileUrl}</div>
    </div>
</Dialog>

<div class="file" class:compact={$userSettings.compactFileList}>
    <div class="name" title={file.name}>{file.name}</div>
    <div class="details">
        <input tabindex="0" bind:this={urlInput} on:focus={copy} on:select={copy} on:click={copy} class="link" type="text" readonly value={fileUrl} />
        <button aria-label="Delete link" class="alert" on:click={deleteFile}>
            <Icon class="icon" src="/static/delete.svg"></Icon>
        </button>
        <button aria-label="Show QR code" class="default" on:click={openQr}>
            <svg
                class="qr-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
            >
                <path
                    d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm2 2h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 2h4v2h-4v-2zM19 15h2v2h-2v-2z"
                />
            </svg>
        </button>
        <button aria-label="Open link" class="default">
            <a href={fileUrl} target="file-link" style="display: block; height: 100%; align-content: center;">
                <Icon class="icon" src="/static/open_in_new.svg"></Icon>
            </a>
        </button>
    </div>
    <div class="footer">
        <div class="mimetype">{file.type}</div>
        <div class="date">{new Date(file.date).toLocaleString("sv", { timeZoneName: "shortOffset" })}</div>
        <div>
            {#if $userSettings.showThumbnails}
                <a href={fileUrl} target="_blank">
                    <img
                        class="thumbnail"
                        alt="File Thumbnail"
                        src={thumbUrl}
                        loading="lazy"
                        decoding="async"
                        on:error={function () {
                            this.style = "display: none;";
                        }}
                    />
                </a>
            {:else}
                <span>{file.checksum}</span>
            {/if}
        </div>
        {#if file.private}
            <div class="private-badge">private</div>
        {/if}
    </div>
</div>

<style lang="scss">
    .file {
        display: flex;
        flex-direction: column;
        padding: 10px 8px;
        background-color: rgb(var(--bg_h));
        border-radius: 10px;
        border: 1px solid rgb(var(--outl2));
        border-left: 2px solid rgb(var(--primary));

        &:not(:last-child) {
            margin-bottom: 10px;
            // border-bottom: 2px dashed rgb(var(--primary));
        }

        .details {
            display: flex;
            font-size: 1.2rem;
            border-radius: 5px;
            outline: 1px solid rgb(var(--outl1));
            margin: 2px 0;

            button {
                border-radius: 0;
                padding: 0;
                width: 32px;

                &:last-child {
                    border-radius: 0 5px 5px 0;
                }
                :global(.icon) {
                    vertical-align: middle;
                    width: 18pt;
                    height: 18pt;
                }
            }
        }

        .name {
            font-size: 1.2rem;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .link {
            border-radius: 5px 0 0 5px;
            background-color: rgb(var(--bg));
            font-size: 0.9rem;
            color: rgb(var(--fg2));
            flex: 1;

            &:focus {
                background-color: rgb(var(--bg_h));
            }
        }

        &.compact {
            padding: 6px 6px;
            border-radius: 8px;
        }

        &.compact .details {
            font-size: 1rem;
        }

        &.compact .name {
            font-size: 1rem;
        }

        &.compact .link {
            font-size: 0.8rem;
        }

        &.compact .footer {
            font-size: 0.75rem;
        }

        &.compact .details button {
            width: 28px;
        }

        @media screen and (max-width: 640px) {
            .details {
                flex-wrap: wrap;
            }

            .link {
                flex: 1 1 100%;
                border-radius: 5px 5px 0 0;
            }

            .details button {
                flex: 1 1 auto;
                width: auto;
            }

            & {
                padding: 8px 6px;
                border-radius: 8px;
            }

            .name {
                font-size: 1rem;
                line-height: 1.2;
            }

            .link {
                font-size: 0.8rem;
                word-break: break-all;
            }

            .footer {
                display: grid;
                grid-template-columns: 1fr;
                gap: 4px;
            }

            .mimetype {
                float: none;
            }

            .thumbnail {
                max-height: 40vh;
                width: 100%;
                object-fit: contain;
            }
        }
    }

    button {
        cursor: pointer;
        background-color: rgba(var(--bg2), 0.1);
        border: none;
        color: rgb(var(--fg2));
        border-radius: 5px;

        &:hover {
            background-color: rgba(var(--bg2), 0.2);
        }
    }

    input[type="text"] {
        border: none;
        outline: none;
    }

    input[type="text"] {
        padding: 5px;
    }

    .alert {
        background-color: rgba(255, 0, 0, 0.2);
        &:hover {
            background-color: rgba(255, 0, 0, 0.4);
        }
    }

    .ok {
        background-color: rgba(0, 255, 0, 0.2);
        &:hover {
            background-color: rgba(0, 255, 0, 0.4);
        }
    }

    .default {
        background-color: rgb(var(--bg_h));
        &:hover {
            background: rgb(var(--bg2));
        }
    }

    .qr-icon {
        width: 18px;
        height: 18px;
        fill: currentColor;
        display: block;
        margin: 0 auto;
    }

    .qr-dialog {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: center;
        width: min(320px, 92vw);
        padding: 6px 2px 2px;
    }

    .qr-title {
        font-weight: 600;
        text-align: center;
        width: 100%;
    }

    .qr-image {
        width: 220px;
        height: 220px;
        image-rendering: pixelated;
        border-radius: 8px;
        background: white;
        padding: 6px;
        display: block;
    }

    .qr-link {
        font-size: 0.75rem;
        word-break: break-all;
        color: rgb(var(--fg2));
        text-align: center;
        width: 100%;
    }

    .private-badge {
        font-size: 0.75rem;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(255, 160, 0, 0.2);
        color: rgb(var(--fg));
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .footer {
        font-size: 0.8rem;
        text-overflow: clip;
        overflow: hidden;
    }

    .date {
        margin-right: 5px;
    }

    .mimetype {
        float: right;
    }

    .thumbnail {
        max-width: 100%;
        height: auto;
        margin-top: 5px;
    }

    .delete-dialog {
        font-size: 1.1rem;
        max-width: 500px;
        padding: 10px 0;
        text-align: center;
        overflow: hidden;

        p {
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .option {
            display: flex;
            justify-content: center;
            gap: 10px;

            button {
                outline: 1px solid rgb(var(--outl1));
                font-size: 0.9em;
                padding: 0.25em 1.5em;
            }
        }
    }

    .highlight {
        color: rgb(var(--fg2));
        background-color: rgb(var(--bg2));
        border-radius: 5px;
        padding: 0 2px;
        white-space: nowrap;
    }
</style>
