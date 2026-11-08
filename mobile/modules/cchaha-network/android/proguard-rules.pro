# MainApplication installs CloudflareEdge before React starts; keep the whole
# edge fallback intact (and readable in release stack traces).
-keep class app.cchaha.network.** { *; }
