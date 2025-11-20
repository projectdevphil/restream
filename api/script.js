const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
let activeRequests = 0;

// List of alternative YouTube endpoints to try if primary fails
const YOUTUBE_ENDPOINTS = [
  "https://www.youtube.com",
  "https://youtube.com",
  "https://m.youtube.com",
  "https://www.youtube.com/embed",
  "https://www.youtube-nocookie.com"
];

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    activeRequests++;
    console.log(`Active requests: ${activeRequests}`);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const qp = url.searchParams;
   
    // Log the request for debugging
    console.log(`Processing request for: ${url.pathname}`);
   
    if (parts.length < 2) {
      return new Response("Usage: /@handle/stream.m3u8", { status: 400 });
    }
   
    const handle = parts[0]; // @ptvph or channel id
    const filename = parts[1];
   
    if (!filename.endsWith(".m3u8")) {
      return new Response("Only .m3u8 supported in this Worker", { status: 400 });
    }
   
    // 1) Segment proxy: ?url=<encoded>
    if (qp.has("url")) {
      const target = qp.get("url");
      return await handleSegmentProxy(target, request);
    }
   
    // 2) Variant request: ?variant=<encoded_variant_m3u8_url>
    if (qp.has("variant")) {
      const variantUrl = qp.get("variant");
      return await handleVariantPlaylistProxy(variantUrl, request);
    }
   
    // 3) Master request: fetch youtube page -> get hlsManifestUrl -> fetch master -> rewrite and return
    return await handleMasterRequest(handle, request);
  } catch (err) {
    console.error("Worker error:", err);
    return new Response("Worker error: " + String(err.message || err), {
      status: 500,
      headers: textHeaders(),
    });
  } finally {
    activeRequests--;
    console.log(`Active requests: ${activeRequests}`);
  }
}

/* -------------------------
   Helper functions & steps
   ------------------------- */
function textHeaders() {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
  };
}

function corsHeaders(additional = {}) {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range,Accept,Content-Type",
    "Access-Control-Expose-Headers": "Content-Length,Content-Range",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    ...additional,
  };
  return h;
}

async function fetchWithUA(resource, init = {}) {
  init.headers = Object.assign({
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
  }, init.headers || {});
 
  const controller = new AbortController();
  init.signal = controller.signal;
  const timeoutMs = init.timeoutMs || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
 
  try {
    console.log(`Fetching: ${resource}`);
    const r = await fetch(resource, init);
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    console.error(`Fetch failed for ${resource}:`, e);
    throw e;
  }
}

/* ---- Master: fetch youtube live page & return rewritten master playlist ---- */
async function handleMasterRequest(handle, request) {
  let manifestUrl;
  let lastError;
 
  // Try different approaches to get the manifest URL
  const approaches = [
    // Try with @handle format
    () => extractHlsManifestFromYouTube(`https://www.youtube.com/${handle}/live`),
    // Try with channel ID format
    () => extractHlsManifestFromYouTube(`https://www.youtube.com/channel/${handle}/live`),
    // Try with video ID format
    () => extractHlsManifestFromYouTube(`https://www.youtube.com/watch?v=${handle}`),
    // Try with embed format
    () => extractHlsManifestFromYouTube(`https://www.youtube.com/embed/${handle}`),
    // Try with mobile format
    () => extractHlsManifestFromYouTube(`https://m.youtube.com/watch?v=${handle}`),
    // Try alternative endpoints
    ...YOUTUBE_ENDPOINTS.slice(1).map(endpoint => {
      return () => {
        const url = handle.startsWith("@")
          ? `${endpoint}/${handle}/live`
          : `${endpoint}/watch?v=${handle}`;
        return extractHlsManifestFromYouTube(url);
      };
    })
  ];
 
  // Try each approach until one works
  for (const approach of approaches) {
    try {
      manifestUrl = await approach();
      if (manifestUrl) {
        console.log(`Found manifest URL: ${manifestUrl}`);
        break;
      }
    } catch (e) {
      lastError = e;
      console.warn(`Approach failed: ${e.message}`);
    }
  }
 
  if (!manifestUrl) {
    console.error("All approaches failed to find manifest URL");
    return new Response(`Could not find hlsManifestUrl for this handle/id. Last error: ${lastError?.message || 'Unknown error'}`, {
      status: 404,
      headers: textHeaders(),
    });
  }
 
  try {
    const masterRes = await fetchWithUA(manifestUrl, { method: "GET" });
    if (!masterRes.ok) {
      throw new Error(`Upstream manifest returned ${masterRes.status}`);
    }
   
    const masterTxt = await masterRes.text();
    const encrypted = /#EXT-X-KEY/i.test(masterTxt);
    const proxyBase = request.url.split("?")[0];
   
    // Rewrite URLs in the manifest to go through our proxy
    const rewritten = masterTxt.replace(/(https?:\/\/[^\s\r\n,]+)/g, (m) => {
      if (/\.m3u8(\?|$)/i.test(m)) {
        return `${proxyBase}?variant=${encodeURIComponent(m)}`;
      }
      return `${proxyBase}?variant=${encodeURIComponent(m)}`;
    });
   
    const headers = {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      ...corsHeaders(),
    };
   
    const debug = new URL(request.url).searchParams.get("debug");
    if (debug) {
      const dbg = `# Worker debugging\n# source_manifest: ${manifestUrl}\n# master_encrypted: ${encrypted}\n\n${masterTxt}\n\n--- rewritten ---\n\n${rewritten}`;
      return new Response(dbg, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() }
      });
    }
   
    return new Response(rewritten, { status: 200, headers });
  } catch (e) {
    console.error("Error processing manifest:", e);
    return new Response(`Error processing manifest: ${e.message}`, {
      status: 502,
      headers: textHeaders(),
    });
  }
}

/* ---- Variant playlist proxy: fetch variant m3u8 fresh and rewrite segments ---- */
async function handleVariantPlaylistProxy(variantUrl, request) {
  if (!variantUrl || !/^https?:\/\//i.test(variantUrl)) {
    return new Response("Invalid variant URL", { status: 400, headers: textHeaders() });
  }
 
  try {
    const res = await fetchWithUA(variantUrl, { method: "GET" });
    if (!res.ok) {
      throw new Error(`Upstream variant returned ${res.status}`);
    }
   
    const txt = await res.text();
    const encrypted = /#EXT-X-KEY/i.test(txt);
    const proxyBase = request.url.split("?")[0];
   
    const rewritten = txt
      .split(/\r?\n/)
      .map((line) => {
        if (!line || line.startsWith("#")) return line;
        try {
          const resolved = new URL(line, variantUrl).toString();
          return `${proxyBase}?url=${encodeURIComponent(resolved)}`;
        } catch (e) {
          console.warn(`Failed to resolve URL: ${line}`, e);
          return line;
        }
      })
      .join("\n");
   
    const headers = {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      ...corsHeaders(),
    };
   
    const debug = new URL(request.url).searchParams.get("debug");
    if (debug) {
      const dbg = `# Worker debugging\n# variant_source: ${variantUrl}\n# encrypted: ${encrypted}\n\n--- original variant ---\n\n${txt}\n\n--- rewritten variant ---\n\n${rewritten}`;
      return new Response(dbg, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() }
      });
    }
   
    return new Response(rewritten, { status: 200, headers });
  } catch (e) {
    console.error("Error processing variant playlist:", e);
    return new Response(`Error processing variant playlist: ${e.message}`, {
      status: 502,
      headers: textHeaders(),
    });
  }
}

/* ---- Segment proxy: fetch bytes from the target segment URL and return them ---- */
async function handleSegmentProxy(targetUrl, request) {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return new Response("Invalid segment URL", { status: 400, headers: textHeaders() });
  }
 
  const range = request.headers.get("range");
  const headers = {};
  if (range) headers.Range = range;
 
  let lastErr = null;
 
  // Try multiple times to fetch the segment
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const upstream = await fetchWithUA(targetUrl, {
        method: "GET",
        headers,
        redirect: "follow",
        timeoutMs: 20000
      });
     
      if (upstream.status === 403 || upstream.status === 401) {
        throw new Error(`Upstream blocked (${upstream.status})`);
      }
     
      if (!upstream.ok) {
        throw new Error(`Upstream returned ${upstream.status}`);
      }
     
      const contentType = upstream.headers.get("Content-Type") || guessContentTypeFromUrl(targetUrl);
      const contentLength = upstream.headers.get("Content-Length");
      const contentRange = upstream.headers.get("Content-Range");
     
      const outHeaders = new Headers();
      outHeaders.set("Content-Type", contentType);
      if (contentLength) outHeaders.set("Content-Length", contentLength);
      if (contentRange) outHeaders.set("Content-Range", contentRange);
      outHeaders.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "bytes");
      outHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      outHeaders.set("Access-Control-Allow-Origin", "*");
      outHeaders.set("Access-Control-Expose-Headers", "Content-Length,Content-Range");
      outHeaders.set("Vary", "Origin");
     
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    } catch (err) {
      lastErr = err;
      console.warn(`Segment fetch attempt ${attempt + 1} failed:`, err);
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
 
  console.error("All segment fetch attempts failed");
  return new Response("Failed to fetch segment: " + String(lastErr), {
    status: 502,
    headers: textHeaders()
  });
}

/* ---- Utility: get hlsManifestUrl from youtube page ---- */
async function extractHlsManifestFromYouTube(youtubePageUrl) {
  try {
    const res = await fetchWithUA(youtubePageUrl, { method: "GET" });
    if (!res.ok) throw new Error(`YouTube returned ${res.status}`);
   
    const text = await res.text();
   
    // Try multiple regex patterns to find the manifest URL
    const patterns = [
      /(?<=hlsManifestUrl":")[^"]+\.m3u8/g,
      /"hlsManifestUrl"\s*:\s*"([^"]+\.m3u8)"/,
      /https?:\/\/[^"']+\.m3u8[^"']*/,
      /"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
      /"streamingData"\s*:\s*({[^}]+})/
    ];
   
    for (const pattern of patterns) {
      let m = text.match(pattern);
      if (m && m[0]) {
        let manifestUrl = m[0];
        // If it's a streamingData object, try to parse it
        if (pattern === patterns[4]) {
          try {
            const streamingData = JSON.parse(manifestUrl);
            if (streamingData.hlsManifestUrl) {
              manifestUrl = streamingData.hlsManifestUrl;
            }
          } catch (e) {
            continue;
          }
        }
       
        // Clean up the URL
        manifestUrl = manifestUrl.replace(/\\u0026/g, "&");
        manifestUrl = decodeURIComponent(manifestUrl.replace(/\&amp;/g, "&"));
       
        if (manifestUrl.startsWith("http")) {
          return manifestUrl;
        }
      }
    }
   
    throw new Error("hlsManifestUrl not found in YouTube page HTML");
  } catch (e) {
    console.error(`Failed to extract manifest from ${youtubePageUrl}:`, e);
    throw e;
  }
}

function guessContentTypeFromUrl(u) {
  if (/\.(m3u8)(\?|$)/i.test(u)) return "application/vnd.apple.mpegurl";
  if (/\.(ts)(\?|$)/i.test(u)) return "video/mp2t";
  if (/\.(mp4)(\?|$)/i.test(u)) return "video/mp4";
  return "application/octet-stream";
}
