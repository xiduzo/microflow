import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('mhb-root');
const root = createRoot(container!);
root.render(<App />);
