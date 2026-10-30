# Testing on Windows

Test the published dev snapshot through npx, exactly what users get. Needs Node 20+ and Windows Terminal (the old conhost console has poorer colours and mouse support). Commands are for PowerShell.

```powershell
$vv = "vkusvill@0.0.0-dev.1"   # the snapshot under test
npx $vv --version
npx $vv login
npx $vv auth
npx $vv orders
```

`auth` should report `Секреты: файл, зашифрованный Windows (DPAPI)`. Then make sure no secret is stored in the clear:

```powershell
Get-Content $env:APPDATA\vv-cli\auth.json
Get-Content $env:APPDATA\vv-cli\secrets.dpapi
```

`auth.json` holds only `clientId`, the expiry, the rights and `"secrets": "store"`; `secrets.dpapi` is base64 noise with no recognisable words.

The interface:

```powershell
npx $vv
```

Check: colours and photos; `↑` from the search box into the header, `← →` across the tabs; typing in Russian; mouse clicks; `o` opens a product on the website; in shops, `y` copies an address that pastes as proper Cyrillic; in the cart, `p` shows the QR code and the link.

Do not send tokens or the secret: the output of `auth` is enough for debugging.
