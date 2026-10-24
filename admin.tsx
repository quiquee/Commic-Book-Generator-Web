import React from 'react';
import { createRoot } from 'react-dom/client';
import './admin.css';
import { AdminApp } from './AdminApp';

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <AdminApp />
    </React.StrictMode>
);
