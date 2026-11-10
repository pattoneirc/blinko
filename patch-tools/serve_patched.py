#!/usr/bin/env python3
"""Blinko 补丁前端本地试跑代理（不改 NAS）。

- 静态文件：本目录下的 public/（用打过补丁的 1.8.8 前端构建）
- 其他请求：原样透传到上游 Blinko（默认 http://100.93.14.80:5300）
- 浏览器访问 http://127.0.0.1:8090 即可，同源，没有跨域问题

用法：
    python serve_patched.py                # 127.0.0.1:8090 -> NAS
    python serve_patched.py --port 8091 --upstream http://100.93.14.80:5300
    python serve_patched.py --host 0.0.0.0 # 让手机在同一局域网也能访问
"""
import argparse
import http.client
import http.server
import os
import sys
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
UPSTREAM = "http://100.93.14.80:5300"
PERF_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "perf.log")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}

# 只在试跑代理里注入：记录长任务 / 掉帧 / API 请求，用来定位滚动时的“一顿”
PERF_BEACON = """
<script>
(function(){
  if (window.__perfBeacon) return; window.__perfBeacon = true;
  var sent = 0;
  function post(o){
    if (sent > 80) return; sent++;
    try {
      var b = JSON.stringify(o);
      if (navigator.sendBeacon) navigator.sendBeacon('/__perf', b);
      else fetch('/__perf', {method:'POST', body:b, keepalive:true});
    } catch(e){}
  }
  try {
    new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){
        if (e.duration >= 60) post({t:'longtask', at:Math.round(e.startTime), ms:Math.round(e.duration),
          attr:(e.attribution||[]).map(function(a){return a.name+':'+(a.containerType||'')}).join(',')});
      });
    }).observe({entryTypes:['longtask']});
  } catch(e){}
  var last = performance.now();
  (function tick(t){
    var gap = t - last; last = t;
    if (gap > 90 && document.visibilityState === 'visible') post({t:'framegap', at:Math.round(t), ms:Math.round(gap)});
    requestAnimationFrame(tick);
  })(performance.now());
  var of = window.fetch;
  window.fetch = function(){
    var a = arguments, url = String(a[0]||''), t0 = performance.now();
    return of.apply(this, a).then(function(r){
      if (url.indexOf('/api/') >= 0) post({t:'api', url:url.slice(0,400), ms:Math.round(performance.now()-t0), at:Math.round(t0), s:r.status,
        page:location.pathname+location.search,
        sinceScroll:Math.round(performance.now() - (window.__lastScroll||0))});
      return r;
    });
  };
  window.__lastScroll = 0;
  window.addEventListener('scroll', function(){ window.__lastScroll = performance.now(); }, true);
  function navLog(kind){ post({t:'nav', kind:kind, url:location.pathname+location.search, at:Math.round(performance.now())}); }
  ['pushState','replaceState'].forEach(function(k){
    var f = history[k];
    history[k] = function(){ var r = f.apply(this, arguments); navLog(k); return r; };
  });
  window.addEventListener('popstate', function(){ navLog('popstate'); });
  post({t:'boot', url:location.href, at:Math.round(performance.now())});
})();
</script>
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    upstream = urllib.parse.urlsplit(UPSTREAM)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    # ---- 工具 ----
    def _is_api(self, path):
        return path.startswith("/api/") or path == "/api"

    def _proxy(self, method):
        parsed = self.upstream
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None

        headers = {}
        for k, v in self.headers.items():
            if k.lower() in HOP_BY_HOP:
                continue
            headers[k] = v

        conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=120)
        try:
            conn.request(method, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() in HOP_BY_HOP:
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(data)
        except Exception as exc:  # 上游挂了也要给浏览器一个明确错误
            msg = ("upstream error: %s" % exc).encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
        finally:
            conn.close()

    def _serve_static(self):
        path = urllib.parse.urlsplit(self.path).path

        # 试跑时先禁用 Service Worker，避免旧缓存干扰
        if path == "/registerSW.js":
            data = b"// disabled in local patch trial\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        fs_path = os.path.join(ROOT, path.lstrip("/"))
        if path == "/" or not os.path.isfile(fs_path):
            # SPA 兜底：没有扩展名的路由一律给 index.html；带扩展名但本地没有的静态资源
            # （Vditor 的 /dist/js/lute/*、/dist/js/highlight.js/*、locales 等）转给上游，
            # 否则编辑器初始化会缺文件，表现为只有工具栏、没有输入区。
            if path != "/" and os.path.splitext(path)[1]:
                return self._proxy("GET")
            self.path = "/index.html"

        if self.path.startswith("/index.html"):
            with open(os.path.join(ROOT, "index.html"), "r", encoding="utf-8") as f:
                html = f.read().replace("</body>", PERF_BEACON + "</body>")
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    # ---- 方法 ----
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._is_api(path):
            return self._proxy("GET")
        return self._serve_static()

    def do_HEAD(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._is_api(path):
            return self._proxy("HEAD")
        return self._serve_static()

    def do_OPTIONS(self):
        # 官方 APK 从自己壳里发起跨域请求，会先打 OPTIONS 预检；必须转发给上游，
        # 否则会直接 501，客户端报 failed to fetch。
        path = urllib.parse.urlsplit(self.path).path
        if self._is_api(path):
            return self._proxy("OPTIONS")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/__perf":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            try:
                with open(PERF_LOG, "ab") as f:
                    f.write(body.replace(b"\n", b" ") + b"\n")
            except Exception:
                pass
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self._is_api(path):
            return self._proxy("POST")
        self.send_error(404)

    def do_PUT(self):
        self._proxy("PUT")

    def do_PATCH(self):
        self._proxy("PATCH")

    def do_DELETE(self):
        self._proxy("DELETE")

    # 让 index.html 不被浏览器缓存
    def end_headers(self):
        super().end_headers()


def main():
    global UPSTREAM
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--upstream", default=UPSTREAM)
    args = ap.parse_args()
    UPSTREAM = args.upstream
    Handler.upstream = urllib.parse.urlsplit(args.upstream)

    if not os.path.isdir(ROOT):
        sys.exit("public/ 不存在：%s" % ROOT)

    # Windows 上 SO_REUSEADDR 会让多个进程抢同一个端口（会出现旧代码继续应答），关掉
    http.server.ThreadingHTTPServer.allow_reuse_address = False
    httpd = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    print("patched frontend : %s" % ROOT)
    print("upstream         : %s" % args.upstream)
    print("open             : http://%s:%d" % (args.host if args.host != "0.0.0.0" else "127.0.0.1", args.port))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
