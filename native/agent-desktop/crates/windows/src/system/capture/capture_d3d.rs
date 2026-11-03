//! D3D11 device + staging-texture readback for the modern capture backend.

use agent_desktop_core::{AdapterError, ErrorCode};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::core::Interface;

pub(in crate::system) struct CaptureDevice {
    pub(in crate::system) device: ID3D11Device,
    pub(in crate::system) context: ID3D11DeviceContext,
    pub(in crate::system) winrt: IDirect3DDevice,
}

impl CaptureDevice {
    pub(in crate::system) fn create() -> Result<Self, AdapterError> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|error| d3d_error(error.code().0, "create a D3D11 device"))?;
            let device = device.ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    "D3D11CreateDevice returned no device",
                )
            })?;
            resource_balance::acquire();
            let context = context.ok_or_else(|| {
                resource_balance::release();
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    "D3D11CreateDevice returned no device context",
                )
            })?;
            resource_balance::acquire();
            let dxgi: IDXGIDevice = device.cast().map_err(|error| {
                resource_balance::release();
                resource_balance::release();
                d3d_error(error.code().0, "cast the D3D11 device to IDXGIDevice")
            })?;
            let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(|error| {
                resource_balance::release();
                resource_balance::release();
                d3d_error(error.code().0, "wrap the DXGI device as IDirect3DDevice")
            })?;
            let winrt: IDirect3DDevice = inspectable.cast().map_err(|error| {
                resource_balance::release();
                resource_balance::release();
                d3d_error(error.code().0, "cast the inspectable to IDirect3DDevice")
            })?;
            resource_balance::acquire();
            Ok(Self {
                device,
                context,
                winrt,
            })
        }
    }
}

impl Drop for CaptureDevice {
    fn drop(&mut self) {
        resource_balance::release();
        resource_balance::release();
        resource_balance::release();
    }
}

pub(in crate::system) fn read_texture_bgra(
    device: &CaptureDevice,
    texture: &ID3D11Texture2D,
    content_width: u32,
    content_height: u32,
) -> Result<Vec<u8>, AdapterError> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        let surface_w = desc.Width;
        let surface_h = desc.Height;
        let width = content_width.min(surface_w);
        let height = content_height.min(surface_h);
        if width == 0 || height == 0 {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "modern capture produced a zero-sized frame",
            ));
        }

        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging = None;
        device
            .device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .map_err(|error| d3d_error(error.code().0, "create a staging texture"))?;
        let staging = staging.ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                "CreateTexture2D returned no staging texture",
            )
        })?;
        resource_balance::acquire();
        let _staging_guard = BalanceGuard;

        device.context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        device
            .context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|error| d3d_error(error.code().0, "map the staging texture"))?;
        let pixels = copy_mapped_bgra(&mapped, width, height);
        device.context.Unmap(&staging, 0);
        pixels
    }
}

struct BalanceGuard;

impl Drop for BalanceGuard {
    fn drop(&mut self) {
        resource_balance::release();
    }
}

fn copy_mapped_bgra(
    mapped: &D3D11_MAPPED_SUBRESOURCE,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, AdapterError> {
    if mapped.pData.is_null() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "mapped staging texture had a null data pointer",
        ));
    }
    let row_pitch = mapped.RowPitch as usize;
    let width = width as usize;
    let height = height as usize;
    let row_bytes = width * 4;
    if row_pitch < row_bytes {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "mapped staging texture row pitch is shorter than the content stride",
        ));
    }
    let mut out = vec![0u8; row_bytes * height];
    unsafe {
        let src = mapped.pData as *const u8;
        for y in 0..height {
            let src_row = src.add(y * row_pitch);
            let dst_off = y * row_bytes;
            std::ptr::copy_nonoverlapping(src_row, out[dst_off..].as_mut_ptr(), row_bytes);
        }
    }
    Ok(out)
}

pub(in crate::system) fn texture_from_surface(
    surface: &windows::Graphics::DirectX::Direct3D11::IDirect3DSurface,
) -> Result<ID3D11Texture2D, AdapterError> {
    let access: IDirect3DDxgiInterfaceAccess = surface
        .cast()
        .map_err(|error| d3d_error(error.code().0, "access the frame surface DXGI interface"))?;
    unsafe {
        access
            .GetInterface::<ID3D11Texture2D>()
            .map_err(|error| d3d_error(error.code().0, "get the frame surface as ID3D11Texture2D"))
    }
}

pub(in crate::system) fn d3d_error(hresult: i32, context: &str) -> AdapterError {
    crate::system::runtime::hresult::hresult_error("D3D", hresult, context)
}

pub(crate) mod resource_balance {
    use std::cell::Cell;

    thread_local! {
        static LIVE: Cell<i32> = const { Cell::new(0) };
    }

    pub(crate) fn acquire() {
        LIVE.with(|cell| cell.set(cell.get() + 1));
    }

    pub(crate) fn release() {
        LIVE.with(|cell| cell.set(cell.get() - 1));
    }

    #[cfg(test)]
    pub(crate) fn live() -> i32 {
        LIVE.with(Cell::get)
    }

    #[cfg(test)]
    pub(crate) fn reset() {
        LIVE.with(|cell| cell.set(0));
    }
}
