import asyncio
import socket
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from network import PublicResolver, protect_context


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_mixed_dns_result_is_rejected(self):
        addresses = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443)),
        ]
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=addresses)):
            with self.assertRaises(OSError):
                await PublicResolver().resolve('example.com', 443)

    async def test_resolver_returns_exact_checked_address(self):
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=addresses)) as dns:
            rows = await PublicResolver().resolve('example.com', 443)
            self.assertEqual(rows[0]['host'], '8.8.8.8')
            self.assertEqual(dns.await_count, 1)

    async def test_private_subresource_is_blocked_before_http(self):
        context = SimpleNamespace(route=AsyncMock(), route_web_socket=AsyncMock())
        await protect_context(None, context)
        intercept = context.route.call_args.args[1]
        for url in ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/', 'http://224.0.0.1/']:
            route = SimpleNamespace(request=SimpleNamespace(url=url), abort=AsyncMock(), fulfill=AsyncMock())
            with patch('network.aiohttp.ClientSession') as session:
                await intercept(route)
                route.abort.assert_awaited_once()
                session.assert_not_called()


if __name__ == '__main__':
    unittest.main()
