import { t } from './i18n.ts';

// Decodes without HTMLImageElement.decode(), which can stall indefinitely while the tab is hidden.
export async function loadBitmap(source: Blob): Promise<ImageBitmap> {
    if (typeof createImageBitmap === 'function') return createImageBitmap(source);
    const objectUrl = URL.createObjectURL(source);
    try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error(t('error.readImage')));
            image.src = objectUrl;
        });
        return image as unknown as ImageBitmap;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

export async function toJpegDataUrl(source: Blob, maxDimension: number, quality: number): Promise<string> {
    const bitmap = await loadBitmap(source);
    try {
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error(t('error.processImage'));
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', quality);
    } finally {
        if ('close' in bitmap) bitmap.close();
    }
}
