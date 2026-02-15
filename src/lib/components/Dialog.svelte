<script>
    import Icon from "./Icon.svelte";

    /** @type {HTMLDialogElement} */
    export let node;
</script>

<dialog bind:this={node}>
    <a
        href="."
        class="close-btn"
        on:click={(e) => {
            e.preventDefault();
            node.close();
        }}>
        <Icon src="/static/close.svg"></Icon>
    </a>
    <section>
        <slot />
    </section>
</dialog>

<style lang="scss">
    dialog {
        background-color: rgb(var(--bg));
        color: rgb(var(--fg));
        border: 2px solid rgb(var(--primary));
        border-radius: 5px;
        padding: 0.65rem;
        outline: none;
        word-wrap: break-word;
        overscroll-behavior: contain;
        max-width: min(720px, 92vw);
        max-height: 90vh;

        &::backdrop {
            background-color: rgba(0, 0, 0, 0.2);
        }
    }

    .close-btn {
        width: 1.5rem;
        height: 1.5rem;
        cursor: pointer;
        position: sticky;
        float: right;
        top: 0;
        right: 0;
        text-decoration: none;
        opacity: 0.5;

        &:hover {
            opacity: 1;
        }
    }

    section {
        margin: 0 5px;
    }

    @media screen and (max-width: 640px) {
        dialog {
            width: 92vw;
            padding: 0.5rem;
        }

        .close-btn {
            width: 1.25rem;
            height: 1.25rem;
        }

        section {
            margin: 0 2px;
        }
    }
</style>
