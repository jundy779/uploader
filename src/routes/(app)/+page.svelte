<script>
    import { page } from "$app/stores";
    import Dialog from "$lib/components/Dialog.svelte";
    import { logError } from "$lib/components/errorLog";
    import Errors from "$lib/components/Errors.svelte";
    import { userSettings } from "$lib/userSettings";
    import { uploadedFiles, saveFiles, loadFiles } from "$lib/components/files";
    import { onMount } from "svelte";
    import FileDisplay from "$lib/components/File.svelte";
    import { dev } from "$app/environment";
    import { cleanBuffer } from "$lib/utils.js";

    let mountDate = Date.now();

    const apiBase = import.meta.env.VITE_API_BASE_URL || "";
    const apiToken = import.meta.env.VITE_API_TOKEN || "";

    let disabled = false;

    /** @type {HTMLInputElement} */
    let fileInput;

    /** @type {Number?} */
    let uploadProgress = null;

    /** @type {HTMLDivElement} */
    let dropZone;

    /** @type {HTMLDialogElement} */
    let errorDialog;

    /** @type {HTMLDialogElement} */
    let preUploadDialog;

    /** @type {EventTarget} */
    let lastTarget;

    const notifyError = (/** @type {string} */ msg) => {
        logError(msg);
        errorDialog.showModal();
    };

    const removeExif = (/** @type {File} */ file) => {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                if (!(fr.result instanceof ArrayBuffer))
                    return reject("Failed reading image buffer");

                const cleanedBuffer = cleanBuffer(fr.result);
                const blob = new Blob([cleanedBuffer], { type: file.type });
                const newFile = new File([blob], file.name, {
                    type: file.type,
                });
                resolve(newFile);
            };
            fr.readAsArrayBuffer(file);
        });
    };

    let filesCount = 0;
    let pendingCount = 0;

    const maxRetries = 2;

    /** @type {Array<{ id: number, name: string, size: number, loaded: number, total: number, progress: number, startTime: number, eta: number | null, speed: number | null, status: "uploading" | "retrying" | "done" | "error", attempt: number, isPrivate: boolean, password: string }>} */
    let uploadItems = [];

    /** @type {Array<{ id: number, file: File, name: string, isPrivate: boolean, password: string }>} */
    let pendingUploads = [];

    const refreshUploads = () => {
        uploadItems = [...uploadItems];
    };

    const formatDuration = (/** @type {number} */ seconds) => {
        if (!Number.isFinite(seconds)) return "—";
        const total = Math.max(0, Math.round(seconds));
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const formatBytes = (/** @type {number} */ bytes) => {
        if (!Number.isFinite(bytes)) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        let size = Math.max(0, bytes);
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }
        return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    };

    const formatSpeed = (/** @type {number | null} */ speed) => {
        if (speed === null || !Number.isFinite(speed)) return "—";
        return `${speed.toFixed(speed >= 10 ? 0 : 1)} MB/s`;
    };

    const updateOverallProgress = () => {
        const activeItems = uploadItems.filter(
            (item) => item.status !== "done" && item.status !== "error",
        );
        if (!activeItems.length) {
            uploadProgress = null;
            return;
        }
        const avg =
            activeItems.reduce((sum, item) => sum + item.progress, 0) /
            activeItems.length;
        uploadProgress = Math.round(avg);
    };

    const buildFileUrl = (/** @type {import("$lib/types.js").File} */ file) => {
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
        return base.toString();
    };

    const copyLatest = () => {
        const latest = $uploadedFiles[0];
        if (!latest) return;
        navigator.clipboard.writeText(buildFileUrl(latest));
    };

    const openLatest = () => {
        const latest = $uploadedFiles[0];
        if (!latest) return;
        window.open(buildFileUrl(latest), "_blank");
    };

    const openFilePicker = () => {
        if (!fileInput) return;
        fileInput.click();
    };

    const isTypingTarget = (/** @type {EventTarget | null} */ target) => {
        if (!(target instanceof HTMLElement)) return false;
        if (target.isContentEditable) return true;
        return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    };

    const handleShortcuts = (/** @type {KeyboardEvent} */ e) => {
        if (e.defaultPrevented || isTypingTarget(e.target)) return;
        const isCommand = e.ctrlKey || e.metaKey;
        if (!isCommand || !e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === "u") {
            e.preventDefault();
            openFilePicker();
            return;
        }
        if (key === "c") {
            e.preventDefault();
            copyLatest();
            return;
        }
        if (key === "o") {
            e.preventDefault();
            openLatest();
        }
    };

    const createUploadItem = (
        /** @type {File} */ file,
        /** @type {string} */ displayName,
        /** @type {boolean} */ isPrivate,
        /** @type {string} */ password,
    ) => {
        /** @type {typeof uploadItems[number]} */
        const item = {
            id: filesCount++,
            name: displayName,
            size: file.size,
            loaded: 0,
            total: file.size,
            progress: 0,
            startTime: Date.now(),
            eta: null,
            speed: null,
            status: "uploading",
            attempt: 0,
            isPrivate,
            password,
        };
        return item;
    };

    const scheduleCleanupDoneUpload = (/** @type {number} */ id) => {
        setTimeout(() => {
            const current = uploadItems.find((x) => x.id === id);
            if (!current || current.status !== "done") return;
            uploadItems = uploadItems.filter((x) => x.id !== id);
            updateOverallProgress();
        }, 1500);
    };

    const startUpload = async (
        /** @type {File} */ file,
        /** @type {typeof uploadItems[number]} */ item,
        /** @type {number} */ attempt,
    ) => {
        item.attempt = attempt;
        item.status = attempt > 0 ? "retrying" : "uploading";
        item.startTime = Date.now();
        item.loaded = 0;
        item.total = file.size;
        item.progress = 0;
        item.eta = null;
        item.speed = null;
        refreshUploads();
        updateOverallProgress();

        const formData = new FormData();

        if ($userSettings.stripExif && file.type.startsWith("image/")) {
            try {
                formData.append(
                    "file",
                    await removeExif(file),
                    item.name || file.name,
                );
            } catch (err) {
                item.status = "error";
                refreshUploads();
                updateOverallProgress();
                notifyError(`Error reading "${file.name}":\n${err}`);
                return;
            }
        } else {
            formData.append("file", file, item.name || file.name);
        }
        formData.append("visibility", item.isPrivate ? "private" : "public");
        if (item.isPrivate && item.password) {
            formData.append("password", item.password);
        }

        const xhr = new XMLHttpRequest();

        const retryUpload = (/** @type {string} */ message, canRetry = true) => {
            if (canRetry && attempt < maxRetries) {
                item.status = "retrying";
                item.progress = 0;
                item.loaded = 0;
                item.eta = null;
                item.speed = null;
                refreshUploads();
                updateOverallProgress();
                setTimeout(() => {
                    startUpload(file, item, attempt + 1);
                }, 700);
                return;
            }
            item.status = "error";
            refreshUploads();
            updateOverallProgress();
            notifyError(message);
        };

        xhr.addEventListener("load", () => {
            try {
                if (xhr.status === 413) {
                    return retryUpload(
                        `Failed uploading "${file.name}": File too large`,
                        false,
                    );
                }
                if (xhr.status !== 200) {
                    try {
                        const res = JSON.parse(xhr.response);
                        return retryUpload(
                            `Error uploading "${file.name}": (${xhr.status})\n${JSON.stringify(res, null, 4)}`,
                        );
                    } catch (_) {
                        return retryUpload(
                            `Error uploading "${file.name}": (${xhr.status})`,
                        );
                    }
                }

                const res = JSON.parse(xhr.response);

                item.progress = 100;
                item.loaded = item.total;
                item.eta = 0;
                item.speed = null;
                item.status = "done";
                refreshUploads();
                updateOverallProgress();

                loadFiles();
                const newFile = {
                    id: res.id,
                    name: item.name || file.name,
                    ext: res.ext,
                    type: file.type || res.type,
                    key: res.key,
                    date: Date.now(),
                    checksum: res.checksum,
                    origin: res.origin,
                    private: Boolean(res.private),
                    password: item.password || "",
                };
                uploadedFiles.update((arr) => {
                    return [
                        newFile,
                        ...arr,
                    ];
                });
                saveFiles();
                if ($userSettings.autoCopyLink && navigator?.clipboard?.writeText) {
                    try {
                        navigator.clipboard.writeText(buildFileUrl(newFile));
                    } catch (_) {}
                }
                scheduleCleanupDoneUpload(item.id);
            } catch (err) {
                retryUpload(
                    `Unexpected error uploading "${file.name}": (${xhr.status})\n${err}`,
                );
            }
        });

        xhr.addEventListener("error", (e) => {
            const hint =
                dev && e.loaded === 0
                    ? `\n\nHint: API backend is not running or unreachable at ${apiBase || window.location.origin}. Start the API backend, or set VITE_API_BASE_URL to the correct backend base URL.`
                    : "";
            retryUpload(
                `Failed uploading "${file.name}": ${e.loaded} bytes transferred${hint}`,
            );
        });

        const uploadUrl = new URL("/api/upload", apiBase || window.location.origin);
        if (!$userSettings.fileContentDisposition) {
            uploadUrl.searchParams.set("skip-cd", "true");
        }
        if (apiToken) {
            uploadUrl.searchParams.set("token", apiToken);
        }
        xhr.open("POST", uploadUrl.toString(), true);

        xhr.upload?.addEventListener("progress", (e) => {
            if (!e.lengthComputable) return;

            const elapsed = Date.now() - item.startTime;
            const speed = elapsed > 0 ? e.loaded / elapsed : 0;
            const remaining = Math.max(0, e.total - e.loaded);
            const eta = speed > 0 ? remaining / speed / 1000 : null;
            const speedMB = speed > 0 ? (speed * 1000) / 1024 / 1024 : null;

            item.loaded = e.loaded;
            item.total = e.total;
            item.progress = Math.min(
                100,
                Math.round((e.loaded / e.total) * 100),
            );
            item.eta = eta;
            item.speed = speedMB;
            refreshUploads();
            updateOverallProgress();
        });

        xhr.send(formData);
    };

    const sanitizeName = (/** @type {string} */ value) => {
        return value
            .trim()
            .replace(/[/\\]/g, "_")
            .replace(/[\r\n]/g, "_")
            .slice(0, 180);
    };

    const buildDisplayName = (
        /** @type {string} */ original,
        /** @type {string} */ rename,
    ) => {
        const cleaned = sanitizeName(rename || "");
        if (!cleaned) return original;
        const dot = original.lastIndexOf(".");
        const ext = dot > 0 ? original.slice(dot) : "";
        if (cleaned.includes(".")) return cleaned;
        return `${cleaned}${ext}`;
    };

    const prepareUploads = (/** @type {FileList} */ files) => {
        const list = Array.from(files || []);
        if (!list.length) return;
        pendingUploads = list.map((file) => ({
            id: pendingCount++,
            file,
            name: file.name,
            isPrivate: false,
            password: "",
        }));
        preUploadDialog.showModal();
    };

    const confirmPendingUploads = () => {
        if (pendingUploads.some((item) => item.isPrivate && !item.password.trim())) {
            notifyError("Password is required for private files");
            return;
        }
        const items = pendingUploads;
        pendingUploads = [];
        preUploadDialog.close();
        disabled = true;
        for (const entry of items) {
            const displayName = buildDisplayName(entry.file.name, entry.name);
            const uploadItem = createUploadItem(
                entry.file,
                displayName,
                entry.isPrivate,
                entry.password,
            );
            uploadItems = [uploadItem, ...uploadItems];
            refreshUploads();
            updateOverallProgress();
            startUpload(entry.file, uploadItem, 0);
        }
        disabled = false;
    };

    const cancelPendingUploads = () => {
        pendingUploads = [];
        preUploadDialog.close();
    };

    const fileInputChange = () => {
        if (!fileInput.files) return;
        prepareUploads(fileInput.files);
    };

    const dragFiles = (/** @type {DragEvent} */ e) => {
        if (!e.dataTransfer?.types.includes("Files") || !e.target) return;

        e.preventDefault();
        lastTarget = e.target;
        dropZone.style.visibility = "visible";
        e.dataTransfer.dropEffect = "copy";
    };

    const dragLeave = (/** @type {DragEvent} */ e) => {
        if (e.target !== lastTarget && e.target !== document) return;
        dropZone.style.visibility = "hidden";
    };

    const dropFiles = (/** @type {DragEvent} */ e) => {
        if (!e.dataTransfer?.files) return;

        e.preventDefault();
        dropZone.style.visibility = "hidden";
        prepareUploads(e.dataTransfer.files);
    };

    const pasteFiles = (/** @type {ClipboardEvent} */ e) => {
        if (disabled || !e.clipboardData?.files) return;

        e.preventDefault();
        prepareUploads(e.clipboardData.files);
    };

    onMount(() => {
        mountDate = Date.now();
        loadFiles();
        const handlePreUploadClose = () => {
            pendingUploads = [];
        };
        preUploadDialog?.addEventListener("close", handlePreUploadClose);
        return () => {
            preUploadDialog?.removeEventListener("close", handlePreUploadClose);
        };
    });
</script>

<svelte:window
    on:dragleave={dragLeave}
    on:dragover={dragFiles}
    on:dragenter={dragFiles}
    on:drop={dropFiles}
    on:keydown={handleShortcuts}
/>

<svelte:body on:paste={pasteFiles} />

<div class="drop-zone" bind:this={dropZone}></div>

<Dialog bind:node={errorDialog}>
    <section>
        <Errors></Errors>
    </section>
</Dialog>

<Dialog bind:node={preUploadDialog}>
    <section class="preupload">
        <h3>Prepare upload</h3>
        {#if pendingUploads.length}
            <div class="preupload-list">
                {#each pendingUploads as item (item.id)}
                    <div class="preupload-item">
                        <div class="preupload-row">
                            <span class="preupload-label">Name</span>
                            <input
                                type="text"
                                class="preupload-input"
                                bind:value={item.name}
                                placeholder={item.file.name}
                            />
                        </div>
                        <div class="preupload-row">
                            <label class="preupload-toggle">
                                <input type="checkbox" bind:checked={item.isPrivate} />
                                Private
                            </label>
                            {#if item.isPrivate}
                                <input
                                    type="password"
                                    class="preupload-input"
                                    bind:value={item.password}
                                    placeholder="Password"
                                />
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
            <div class="preupload-actions">
                <button class="upload-label" on:click={confirmPendingUploads}>
                    Upload
                </button>
                <button class="upload-label secondary" on:click={cancelPendingUploads}>
                    Cancel
                </button>
            </div>
        {:else}
            <p>No files selected.</p>
        {/if}
    </section>
</Dialog>

<section>
    {#if /(kappa.lol|gachi.gay|femboy.beauty)$/.test($page.url.hostname) }
        <p style="display: inline-block; margin: 0;">
            <b>{$page.url.hostname}</b> is no longer hosted by me. Past files will not be recovered<br/>
            <span style="float: right; font-size: 8pt;">&mdash;Supa</span>
        </p>
    {/if}
    <p>
        Max file size: 100 MiB<br />Drag or paste files anywhere on this page to
        start uploading
    </p>

    <div class="upload-area">
        <label class="upload-label">
            <input
                bind:this={fileInput}
                on:change={fileInputChange}
                type="file"
                id="file-input"
                {disabled}
                multiple
                accept="image/*,video/*,audio/*,*/*"
            />
            Choose Files
        </label>
    </div>

    {#if uploadProgress !== null}
        <p>Uploading... ({uploadProgress}%)</p>
    {/if}
    {#if uploadItems.length}
        <div class="upload-progress">
            {#each uploadItems as item (item.id)}
                <div class="upload-item">
                    <div class="upload-item-header">
                        <span class="upload-name" title={item.name}
                            >{item.name}</span
                        >
                        <span class="upload-meta">
                            {formatBytes(item.loaded)} / {formatBytes(item.total)}
                            · {item.progress}%
                            {#if item.speed !== null && item.status !== "done" && item.status !== "error"}
                                · {formatSpeed(item.speed)}
                            {/if}
                            {#if item.eta !== null && item.status !== "done" && item.status !== "error"}
                                · ETA {formatDuration(item.eta)}
                            {/if}
                        </span>
                    </div>
                    <progress max="100" value={item.progress}></progress>
                    <div class="upload-status">
                        {#if item.status === "retrying"}
                            retry {item.attempt}/{maxRetries}
                        {:else if item.status === "error"}
                            failed
                        {:else if item.status === "done"}
                            done
                        {:else}
                            uploading
                        {/if}
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</section>

<div class="uploaded-files">
    {#each $uploadedFiles as file (file.id)}
        <FileDisplay isNewUpload={file.date > mountDate} {notifyError} {file} />
    {/each}
</div>

<style lang="scss">
    .drop-zone {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 999;
        opacity: 0.5;
        visibility: hidden;
        display: block;
        background: gray url("/static/upload.svg") no-repeat center;
        background-size: 30%;
    }

    .preupload {
        min-width: min(640px, 90vw);
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .preupload-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 50vh;
        overflow: auto;
    }

    .preupload-item {
        border: 2px solid rgb(var(--outl1));
        border-radius: 6px;
        box-shadow: 2px 2px 0 rgb(var(--primary));
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: rgb(var(--bg0));
    }

    .preupload-row {
        display: grid;
        grid-template-columns: 70px 1fr;
        gap: 10px;
        align-items: center;
    }

    .preupload-label {
        font-size: 0.85rem;
        color: rgb(var(--fg2));
    }

    .preupload-input {
        width: 100%;
        min-width: 0;
        background: rgb(var(--bg));
        border: 2px solid rgb(var(--outl2));
        border-radius: 5px;
        color: rgb(var(--fg2));
        padding: 6px 10px;
    }

    .preupload-toggle {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        font-size: 0.9rem;
    }

    .preupload-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }

    @media screen and (max-width: 640px) {
        .preupload {
            min-width: 0;
            width: 100%;
            gap: 10px;
        }

        .preupload-row {
            grid-template-columns: 1fr;
        }

        .preupload-label {
            font-weight: 600;
        }

        .preupload-item {
            padding: 8px;
            box-shadow: none;
        }

        .preupload-input {
            font-size: 0.9rem;
            padding: 6px 8px;
        }

        .preupload-actions {
            flex-direction: column;
            align-items: stretch;
        }

        .preupload-actions .upload-label {
            width: 100%;
            min-width: 0;
        }
    }

    #file-input {
        display: none;
    }

    .upload-area {
        display: flex;
    }

    .upload-label {
        font-size: 1.2rem;
        font-weight: bold;
        min-width: 130px;
        text-align: center;
        color: rgb(var(--fg2));
        text-shadow: 0 0 2px rgb(var(--bg0));
        border: 2px solid rgb(var(--primary));
        padding: 6px 12px;
        cursor: pointer;
        display: inline-block;
        background: rgb(var(--bg_h));
        transition: transform ease-out 150ms;
        border-radius: 5px;

        &:hover {
            background: rgb(var(--bg2));
            transform: scale(105%);
        }
    }

    .upload-label.secondary {
        background: rgb(var(--bg));
        color: rgb(var(--fg));
        border-style: dashed;
        text-shadow: none;
    }

    .upload-label.secondary:hover {
        background: rgb(var(--bg0));
    }

    .uploaded-files {
        margin: 20px 0;
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        max-width: 100%;
    }

    .upload-progress {
        margin-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 100%;
    }

    .upload-item {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid rgb(var(--outl2));
        background: rgb(var(--bg_h));
    }

    .upload-item-header {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-size: 0.9rem;
    }

    .upload-name {
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    @media screen and (max-width: 640px) {
        .upload-item-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
        }

        .upload-name {
            max-width: 100%;
        }
    }

    .upload-meta {
        opacity: 0.75;
        white-space: nowrap;
    }

    progress {
        width: 100%;
        height: 8px;
        margin: 6px 0 2px;
    }

    .upload-status {
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
    }
</style>
