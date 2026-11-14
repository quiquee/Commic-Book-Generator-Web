import React from 'react';

// The app's name drawn like the lettering of the logo. It needs a dark background (see .brand-banner in index.html).
export function Logotype() {
    return (
        <span className="leading-none">
            <span className="logo-word logo-word-mundos">MUNDOS</span> <span className="logo-word logo-word-cruzados">CRUZADOS</span>
        </span>
    );
}
