# Fortis Fitbase Admin API

Small Node.js service used by the Fortis staff map's **Save and publish** button.

## Required Render environment variables

- `ADMIN_PASSWORD`: strong private admin password.
- `GITHUB_TOKEN`: GitHub fine-grained PAT scoped only to `oostreiko72-max/fortis-easychat-sync`, with Contents: Read and write.
- `GITHUB_OWNER`: `oostreiko72-max`
- `GITHUB_REPO`: `fortis-easychat-sync`
- `GITHUB_BRANCH`: `fortis-automation-map-site`
- `GITHUB_PATH`: `fortis-automation-site/staff.html`
- `ALLOWED_ORIGIN`: `https://fortis-fitbase-automation-map.onrender.com`

The service only accepts publish requests from the Fortis static site origin, requires a bearer admin password, validates the HTML, and writes only the configured staff.html file. It never exposes the GitHub token to the browser.

The service uses only Node built-ins and Node's native fetch; no third-party runtime dependencies.
