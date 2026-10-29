"""Browser traffic is fetched through a resolver that checks the actual dialed IP."""
import asyncio
import ipaddress
import socket
import aiohttp
from urllib.parse import urlparse

def is_public(raw):
    ip = ipaddress.ip_address(raw)
    return ip.is_global and not ip.is_multicast and not ip.is_reserved

class PublicResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_INET):
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not infos or any(not is_public(i[4][0]) for i in infos):
            raise OSError("Non-public destination blocked")
        return [dict(hostname=host, host=i[4][0], port=port, family=i[0], proto=i[2], flags=0) for i in infos]
    async def close(self):
        pass

async def protect_context(page, context, **kwargs):
    if getattr(context, "_public_network_protected", False):
        return page
    context._public_network_protected = True
    async def intercept(route):
        req = route.request
        parsed = urlparse(req.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            await route.abort()
            return
        try:
            # aiohttp bypasses resolvers for literal IPs, so validate those here.
            try:
                ip = ipaddress.ip_address(parsed.hostname)
            except ValueError:
                ip = None
            if ip is not None and not is_public(parsed.hostname):
                raise OSError("Non-public destination blocked")
            connector = aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=30)) as session:
                headers = {k: v for k, v in req.headers.items() if k.lower() not in ('host', 'content-length', 'accept-encoding')}
                async with session.request(req.method, req.url, headers=headers, data=req.post_data_buffer, allow_redirects=False) as res:
                    chunks, size = [], 0
                    async for chunk in res.content.iter_chunked(65536):
                        size += len(chunk)
                        if size > 5 * 1024 * 1024:
                            raise OSError("Response too large")
                        chunks.append(chunk)
                    response_headers = {k: v for k, v in res.headers.items() if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')}
                    await route.fulfill(status=res.status, headers=response_headers, body=b''.join(chunks))
        except Exception:
            await route.abort()
    await context.route("**/*", intercept)
    # WebSockets are unnecessary for text extraction and can bypass HTTP routing.
    if hasattr(context, "route_web_socket"):
        await context.route_web_socket("**/*", lambda ws: ws.close())
    return page


_proxy = None
async def deny_proxy():
    """Browser requests that bypass routing (e.g. service workers) must fail closed."""
    global _proxy
    if _proxy is None:
        async def deny(reader, writer):
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        _proxy = await asyncio.start_server(deny, "127.0.0.1", 0)
    return f"http://127.0.0.1:{_proxy.sockets[0].getsockname()[1]}"
