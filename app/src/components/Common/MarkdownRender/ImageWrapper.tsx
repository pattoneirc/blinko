import { Image } from '@heroui/react';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import { getBlinkoFileUrl } from '@/lib/blinkoEndpoint';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';

interface ImageWrapperProps {
  src?: string;
  width?: number | string;
  height?: number | string;
  alt?: string;
}

export const ImageWrapper = ({ src = '', width, height, alt }: ImageWrapperProps) => {
  const props = { width, height, alt }
  if (!src) return null;
  const imageUrl = getBlinkoFileUrl(src, { token: RootStore.Get(UserStore).tokenData.value?.token });

  // 内部文件走服务端缩略图（500px），避免用原图解码后再缩到 200px 高
  const isInternalFile = /\/api\/file\//.test(src);
  const inlineSrc = isInternalFile ? `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}thumbnail=true` : imageUrl;

  return (
    <div className='markdown-image-wrapper w-full'>
      <PhotoProvider>
        <PhotoView src={imageUrl} >
          <Image src={inlineSrc} {...props} loading="lazy" decoding="async"
            classNames={{
              wrapper: '!max-w-fit !m-auto',
            }} className='w-full max-h-[200px] object-cover' />
        </PhotoView>
      </PhotoProvider>
    </div>
  );
};
