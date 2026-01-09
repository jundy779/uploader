<script>
    import Icon from "./Icon.svelte";
</script>

<h2 class="title">
    <Icon class="icon" src="/static/heart.svg"></Icon>
    Support
</h2>

<p>This website is an entirely free and ad-less service sustained without profit in mind.<br />Every donation is greatly appreciated!</p>

<p>
    <b>Stripe - USD (Card, Paypal, Apple, Google, USA Bank):</b><br />
    <a href="https://donate.stripe.com/8x26oI2nQenr8Sv9FM1B600" target="_blank"><b>https://donate.stripe.com/8x26oI2nQenr8Sv9FM1B600</b></a>
</p>

<p>
    <b>Stripe - EUR (Card, Paypal, Apple, Google, EU Bank):</b><br />
    <a href="https://donate.stripe.com/14A7sM6E6a7bfgTdW21B601" target="_blank"><b>https://donate.stripe.com/14A7sM6E6a7bfgTdW21B601</b></a>
</p>

<p>
    <b>Ko-fi (Card, Paypal):</b><br />
    <a href="https://ko-fi.com/MaldEntertainmentStudio" target="_blank"><b>https://ko-fi.com/MaldEntertainmentStudio</b></a>
</p>

<style lang="scss">
    .title {
        color: rgb(var(--fg2));
    }

    .title :global(.icon) {
        vertical-align: middle;
        width: 12pt;
        height: 12pt;
        animation: pulse 0.8s ease-in infinite alternate;
    }

    @keyframes pulse {
        to {
            transform: scale(1.25);
            background-color: #c81919;
        }
    }
</style>
