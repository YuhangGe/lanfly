import { bootstrap, destroyComponent } from 'jinge';

import './theme/tailwind.css';
import App from './App';
import { registerErrors } from './service/errors';

registerErrors();
const app = bootstrap(App, document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => destroyComponent(app));
