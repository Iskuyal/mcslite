import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
const b = document.getElementById('boot');
if (b) b.remove();
