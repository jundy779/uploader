document.title = window.location.hostname;

const params = new URLSearchParams(window.location.search);
const rawQuery = window.location.search.substring(1);
const key = params.get("key") || (rawQuery && !rawQuery.includes("=") ? rawQuery : "");
const token = params.get("token") || "";

const loadObject = async () => {
    try {
        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
        const res = await fetch(`/api/object?key=${encodeURIComponent(key)}${tokenParam}`);
        const file = await res.json();
        if (file.error) return msg.innerHTML = `Error ${file.error}: ${file.message}`;

        object.innerText = `${file.id}: ${file.type}`;

        if (file.type.startsWith('image/'))
            preview.src = `/${file.id}`;
        else {
            preview.style.display = "none";
            object.style['font-size'] = '1.5em';
        }

        msg.innerText = 'Are you sure you want to delete this file?';
        content.style.display = "block";
    } catch (e) {
        console.error(e);
        msg.innerText = 'Request failed';
    }
};

const deleteObject = async () => {
    try {
        content.style.display = "none";
        msg.innerText = 'Deleting...';

        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
        const res = await fetch(`/api/delete?key=${encodeURIComponent(key)}${tokenParam}`, { method: "POST" });
        const json = await res.json();
        if (json.error) return msg.innerHTML = `Delete Error ${json.error}: ${json.message}`;

        msg.innerHTML = 'Your file has been successfully deleted from our servers.';
    } catch (e) {
        console.error(e);
        msg.innerText = 'Delete request failed';
    }
};

if (!key) msg.innerText = 'No key specified.';
else {
    msg.innerText = "Loading...";
    loadObject();
}
