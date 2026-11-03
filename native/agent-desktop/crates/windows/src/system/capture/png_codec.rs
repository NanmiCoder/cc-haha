//! BGRA↔PNG codec backed by WIC and an in-memory `CreateStreamOnHGlobal` stream.

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, MAX_PNG_INPUT_BYTES};
use std::ptr::{null, null_mut};

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
    IWICBitmapEncoder, IWICBitmapFrameEncode, IWICImagingFactory, IWICPalette,
    WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, IPropertyBag2};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, IStream, STATFLAG_NONAME, STREAM_SEEK_SET,
};

const MAX_PNG_PIXELS: u64 = 64 * 1024 * 1024;
const BYTES_PER_PIXEL: u32 = 4;

pub(crate) fn encode_bgra_to_png(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    deadline: Deadline,
) -> Result<Vec<u8>, AdapterError> {
    deadline.ensure_remaining()?;
    let needed = validate_encode_input(pixels, width, height, stride)?;
    encode_bgra_to_png_wic(&pixels[..needed], width, height, stride)
}

pub(crate) fn decode_png_to_bgra(
    png: &[u8],
    deadline: Deadline,
) -> Result<(Vec<u8>, u32, u32), AdapterError> {
    deadline.ensure_remaining()?;
    validate_decode_input(png)?;
    decode_png_to_bgra_wic(png)
}

fn validate_encode_input(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
) -> Result<usize, AdapterError> {
    if width == 0 || height == 0 {
        return Err(invalid_image("BGRA dimensions must be non-zero"));
    }
    let min_stride = width
        .checked_mul(BYTES_PER_PIXEL)
        .ok_or_else(|| invalid_image("BGRA width overflows the stride budget"))?;
    if stride < min_stride {
        return Err(invalid_image(
            "BGRA stride is shorter than width times four bytes",
        ));
    }
    let pixels_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid_image("BGRA dimensions overflow the pixel budget"))?;
    if pixels_count > MAX_PNG_PIXELS {
        return Err(invalid_image("BGRA dimensions exceed the pixel budget"));
    }
    let needed = u64::from(stride)
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid_image("BGRA buffer size overflows"))?;
    if needed > MAX_PNG_INPUT_BYTES as u64 {
        return Err(invalid_image("BGRA buffer exceeds the 64 MiB input budget"));
    }
    let needed = needed as usize;
    if pixels.len() < needed {
        return Err(invalid_image(
            "BGRA buffer is shorter than stride times height",
        ));
    }
    Ok(needed)
}

fn validate_decode_input(png: &[u8]) -> Result<(), AdapterError> {
    if png.is_empty() {
        return Err(invalid_image("PNG payload is empty"));
    }
    if png.len() > MAX_PNG_INPUT_BYTES {
        return Err(invalid_image(
            "PNG payload exceeds the 64 MiB encoded-data budget",
        ));
    }
    Ok(())
}

fn validate_output_dimensions(width: u32, height: u32) -> Result<usize, AdapterError> {
    if width == 0 || height == 0 {
        return Err(invalid_image("Decoded PNG reported zero dimensions"));
    }
    let pixels_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid_image("Decoded PNG dimensions overflow the pixel budget"))?;
    if pixels_count > MAX_PNG_PIXELS {
        return Err(invalid_image(
            "Decoded PNG dimensions exceed the pixel budget",
        ));
    }
    let stride = u64::from(width)
        .checked_mul(u64::from(BYTES_PER_PIXEL))
        .ok_or_else(|| invalid_image("Decoded PNG stride overflows"))?;
    let bytes = stride
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid_image("Decoded PNG buffer size overflows"))?;
    if bytes > MAX_PNG_INPUT_BYTES as u64 {
        return Err(invalid_image(
            "Decoded PNG buffer exceeds the 64 MiB input budget",
        ));
    }
    Ok(bytes as usize)
}

fn encode_bgra_to_png_wic(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
) -> Result<Vec<u8>, AdapterError> {
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| codec_error(error.code().0, "create the WIC imaging factory"))?;
        let bitmap = factory
            .CreateBitmapFromMemory(width, height, &GUID_WICPixelFormat32bppBGRA, stride, pixels)
            .map_err(|error| codec_error(error.code().0, "wrap BGRA pixels as a WIC bitmap"))?;
        let stream: IStream = CreateStreamOnHGlobal(HGLOBAL(null_mut()), true)
            .map_err(|error| codec_error(error.code().0, "create an in-memory WIC stream"))?;
        let encoder: IWICBitmapEncoder = factory
            .CreateEncoder(&GUID_ContainerFormatPng, null())
            .map_err(|error| codec_error(error.code().0, "create the WIC PNG encoder"))?;
        encoder
            .Initialize(&stream, WICBitmapEncoderNoCache)
            .map_err(|error| codec_error(error.code().0, "initialize the WIC PNG encoder"))?;

        let mut frame: Option<IWICBitmapFrameEncode> = None;
        let mut props: Option<IPropertyBag2> = None;
        encoder
            .CreateNewFrame(&mut frame, &mut props)
            .map_err(|error| codec_error(error.code().0, "create a WIC PNG frame"))?;
        let frame = frame.ok_or_else(|| {
            AdapterError::internal("WIC PNG encoder returned no frame encode object")
        })?;
        frame
            .Initialize(props.as_ref())
            .map_err(|error| codec_error(error.code().0, "initialize the WIC PNG frame"))?;
        frame
            .WriteSource(&bitmap, null())
            .map_err(|error| codec_error(error.code().0, "write BGRA pixels into the PNG frame"))?;
        frame
            .Commit()
            .map_err(|error| codec_error(error.code().0, "commit the WIC PNG frame"))?;
        encoder
            .Commit()
            .map_err(|error| codec_error(error.code().0, "commit the WIC PNG encoder"))?;
        read_stream_bytes(&stream)
    }
}

fn decode_png_to_bgra_wic(png: &[u8]) -> Result<(Vec<u8>, u32, u32), AdapterError> {
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| codec_error(error.code().0, "create the WIC imaging factory"))?;
        let stream = factory
            .CreateStream()
            .map_err(|error| codec_error(error.code().0, "create a WIC decode stream"))?;
        stream
            .InitializeFromMemory(png)
            .map_err(|error| codec_error(error.code().0, "bind PNG bytes to a WIC stream"))?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, null(), WICDecodeMetadataCacheOnDemand)
            .map_err(|error| codec_error(error.code().0, "decode PNG bytes with WIC"))?;
        let frame = decoder
            .GetFrame(0)
            .map_err(|error| codec_error(error.code().0, "read the first PNG frame"))?;
        let converter = factory
            .CreateFormatConverter()
            .map_err(|error| codec_error(error.code().0, "create a WIC format converter"))?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|error| codec_error(error.code().0, "convert the PNG frame to 32bpp BGRA"))?;

        let mut width = 0u32;
        let mut height = 0u32;
        converter
            .GetSize(&mut width, &mut height)
            .map_err(|error| codec_error(error.code().0, "read decoded PNG dimensions"))?;
        let bytes = validate_output_dimensions(width, height)?;
        let stride = width
            .checked_mul(BYTES_PER_PIXEL)
            .ok_or_else(|| invalid_image("Decoded PNG stride overflows"))?;
        let mut buffer = vec![0u8; bytes];
        converter
            .CopyPixels(null(), stride, &mut buffer)
            .map_err(|error| codec_error(error.code().0, "copy decoded BGRA pixels"))?;
        Ok((buffer, width, height))
    }
}

fn read_stream_bytes(stream: &IStream) -> Result<Vec<u8>, AdapterError> {
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|error| codec_error(error.code().0, "rewind the in-memory PNG stream"))?;
        let mut stat = std::mem::zeroed();
        stream
            .Stat(&mut stat, STATFLAG_NONAME)
            .map_err(|error| codec_error(error.code().0, "measure the in-memory PNG stream"))?;
        let size = usize::try_from(stat.cbSize).map_err(|_| {
            AdapterError::internal("PNG stream size does not fit in addressable memory")
        })?;
        if size > MAX_PNG_INPUT_BYTES {
            return Err(invalid_image(
                "Encoded PNG exceeds the 64 MiB encoded-data budget",
            ));
        }
        let mut buffer = vec![0u8; size];
        if size == 0 {
            return Ok(buffer);
        }
        let mut read = 0u32;
        let status = stream.Read(buffer.as_mut_ptr().cast(), size as u32, Some(&mut read));
        if status.is_err() {
            return Err(codec_error(status.0, "read the encoded PNG bytes"));
        }
        if read as usize != size {
            return Err(AdapterError::internal(
                "PNG stream read returned fewer bytes than Stat reported",
            ));
        }
        Ok(buffer)
    }
}

fn invalid_image(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

fn codec_error(hresult: i32, context: &str) -> AdapterError {
    crate::system::runtime::hresult::hresult_error("WIC", hresult, context)
}

#[cfg(test)]
#[path = "png_codec_tests.rs"]
mod tests;
