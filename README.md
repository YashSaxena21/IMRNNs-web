# IMRNNs Website

Static website for the IMRNNs paper, codebase, and public checkpoint release.

## Local Preview

```bash
cd IMRNNs-web
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Deploy with GitHub Pages

1. Push this repository to GitHub.
2. Open `Settings -> Pages`.
3. Select `Deploy from a branch`.
4. Choose `main` and `/ (root)`.

The site is plain HTML, CSS, and JavaScript, so no build step is required.
