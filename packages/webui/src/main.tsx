import { bootstrap, destroyComponent, intlInit, t, type Dict } from 'jinge';

import './theme/tailwind.css';
import App from './App';
import { registerErrors } from './service/errors';

const dictionaries = import.meta.glob<{ default: Dict }>('./intl/*.tsx');
const LOCALES = ['zh-CN', 'zh-TW', 'en'] as const;

function initialLocale(): string {
  try {
    const saved = localStorage.getItem('lanfly.locale');
    if (saved && LOCALES.includes(saved as (typeof LOCALES)[number])) return saved;
  } catch {
    // localStorage can be unavailable in private browsing.
  }
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const value = language.toLowerCase();
    if (value.startsWith('zh')) {
      return /hant|tw|hk|mo/.test(value) ? 'zh-TW' : 'zh-CN';
    }
    if (value.startsWith('en')) return 'en';
  }
  return 'zh-CN';
}

const locale = initialLocale();
document.documentElement.lang = locale;
await intlInit({
  defaultLocale: locale,
  dictLoader: async (next) => {
    const load = dictionaries[`./intl/${next}.tsx`];
    if (!load) throw new Error(`Unsupported locale: ${next}`);
    return (await load()).default;
  },
});
document.title = t('LanFly - 局域网聊天、文件互传、键鼠共享和远程桌面');
registerErrors();
const app = bootstrap(App, document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => destroyComponent(app));
