# J-ROCK — ربات معاملاتی فیوچرز با عامل هوش مصنوعی (Bitunix USDT-M)

این پروژه یک ربات معاملاتی فیوچرز با عامل هوش مصنوعی، نوشته‌شده با جاوااسکریپت
(Node 20+، ESM)، روی صرافی Bitunix است. این پروژه چند بخش را با هم ترکیب می‌کند:
اسکنر سیگنال بلادرنگ، یک عامل خودکار مبتنی بر LLM، چت تلگرام، حافظه بلندمدت
Neon، مهارت‌ها (skills)، پرامپت‌های soul/style، ابزارهای MCP و موتور معاملاتی
فیوچرز Bitunix.

## شروع سریع

```bash
npm install
cp env.example .env
# کلیدهای خود را در فایل .env وارد کنید
npm start
```

حالت پیش‌فرض ایمن است: `DRY_RUN=1`. سفارش‌های واقعی در Bitunix فقط پس از آن ارسال
می‌شوند که به‌صورت صریح با `/dryrun 0` آن را خاموش کنید و `/autotrade on` را در
تلگرام فعال نمایید.

## امکانات اصلی

- کلاینت REST و WebSocket فیوچرز USDT-M صرافی Bitunix
- ده استراتژی: روند EMA، مومنتوم RSI، کراس MACD، تأیید حجم، مومنتوم قیمت،
  قدرت ADX، باند بولینگر، نرخ فاندینگ، Super Trend و شکست ATR
- گیت سیگنال چندتایم‌فریمی (`1m`، `3m`، `5m`، `15m`، `1h`): حداقل اطمینان،
  اطمینان هر تایم‌فریم، توافق، حداقل تایم‌فریم‌های واجد شرایط
  (`min_eligible_timeframes`)، توافق اکثریت میان تایم‌فریم‌ها، اسکن‌های تأییدی و
  کول‌داون. اطمینان در برابر **کل** مجموعه استراتژی‌ها سنجیده می‌شود، پس
  استراتژی‌هایی که رأی نمی‌دهند آن را پایین می‌آورند نه اینکه از مخرج حذف شوند.
- ورود قابل‌معامله: مسیر خودکار سفارش `MARKET` را بر پایه مارک زنده ارسال می‌کند،
  نه یک `LIMIT` معلق روی آخرین قیمت اسکنر؛ پس پوزیشن (و در نتیجه TP/SL آن)
  بلافاصله وجود دارد
- TP/SL پویا بر پایه ATR، سر به سر (breakeven)، تریلینگ، گارد فاصله تا
  لیکوییدیشن، و گارد مارجین نگهدارنده در سطوح ریسک پله‌ای (`get_position_tiers`)
  که پیش از کاهش اجباری پوزیشن توسط صرافی، آن را می‌بندد
- هر چهار روش TP/SL صرافی Bitunix از طریق `tpsl_method`: `position`
  (همه‌یا‌هیچ)، `partial` (بستن پله‌ای با `partial_tp_fractions` /
  `partial_tp_roi_steps`)، `trailing` (قیمت فعال‌سازی + برگشت
  `trailing_callback_pct`) و `account` (`account_tp_roi_pct` /
  `account_sl_roi_pct` روی PnL کل حساب)
- هر سه واحد سفارش Bitunix از طریق `order_unit`: `nominal` (ارزش نوشته‌شده به
  USDT)، `cost` (مارجین پرداختی)، `qty` (مقدار ارز پایه)؛ با `basePrecision` جفت
  ارز تبدیل می‌شوند و در برابر `minTradeVolume` / حداکثر حجم سفارش بررسی می‌شوند
- حلقه خودکار عامل با سطوح تفکر (thinking)، بازتازه‌سازی خودکار مدل و نشست‌ها
- ربات تلگرام: `/status`، `/start`، `/stop`، `/settings`، `/dryrun`،
  `/autotrade`، `/memory`، `/resume`، `/models`، `/ask`
- ذخیره‌سازی تنظیمات معتبرشده و حافظه بلندمدت در Postgres (Neon)

## ساختار

```
src/
├── main.js
├── config.js
├── telegram-bot.js
├── telegram-trader.js
├── prompt.js
├── agent/
│   ├── loop.js
│   ├── brain.js
│   ├── auto-model.js
│   ├── thinking.js
│   ├── config.js
│   ├── memory.js
│   ├── skills.js
│   ├── mcp.js
│   ├── tools.js
│   ├── basic-tools.js
│   └── tui.js
├── bitunix/
│   ├── client.js
│   ├── ws.js
│   ├── indicators.js
│   ├── scanner.js
│   ├── risk.js
│   ├── order-units.js
│   └── futures-tools.js
├── trader/
│   ├── trader.js
│   ├── position-manager.js
│   ├── tpsl.js
│   └── agent-tools.js
├── store/
│   ├── memory.js
│   └── persist.js
└── ui/
    └── tui.js

skills/
soul/
tests/
```

## دموی API

اسکریپت `scripts/api-demo.js` همه‌ی اندپوینت‌های REST را پوشش می‌دهد و از
SDK رسمی جاوا مربوط به Bitunix (`github.com/qezawat-a/open-api`، در مسیر
`Demo/Java/src`) گرفته شده است.

```bash
npm run demo -- --list      # فهرست همه اندپوینت‌ها، متد و اینکه تغییردهنده‌اند یا نه
npm run demo -- --dry-run   # دقیقاً همان درخواستی که هر فراخوانی ارسال می‌کند، بدون شبکه
npm run demo                # فراخوانی‌های زنده فقط-خواندنی (نیازمند BITUNIX_API_KEY/SECRET)
```

به‌صورت پیش‌فرض ایمن است: بدون اعتبارنامه هیچ‌چیز ارسال نمی‌شود و فراخوانی‌های
تغییردهنده علاوه بر آن به `BITUNIX_DEMO_TRADE=1` نیاز دارند. جدول اندپوینت‌ها و
نقشه‌ی جاوا-به-Node را در `docs/api-demo.md` و `docs/api-parity.md` ببینید.

## ایمنی

هرگز فایل `.env` را کامیت نکنید. برای معامله‌ی آزمایشی از `DRY_RUN=1` استفاده
کنید. سفارش واقعی نیازمند `DRY_RUN=0` و کلیدهای معتبر Bitunix است.
