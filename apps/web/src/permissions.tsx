import { useId } from "react";
export const permissionOptions = [
  { value: "read-only", label: "Read Only", detail: "只读文件，不执行修改。" },
  {
    value: "ask-for-approval",
    label: "Ask For Approval",
    detail: "修改文件和执行命令前请求批准。",
  },
  {
    value: "auto-approve",
    label: "Auto Approve",
    detail: "自动批准工作区内的编辑和沙箱命令；额外权限仍需批准。",
  },
  {
    value: "full-access",
    label: "Full Access",
    detail: "关闭执行沙箱与常规审批，可访问工作区以外的文件和网络。",
  },
];
export const normalizedPermission = (value: string) =>
  value === "review"
    ? "read-only"
    : ["workspace", "desktop"].includes(value)
      ? "ask-for-approval"
      : value;
export const permissionLabel = (value: string) =>
  permissionOptions.find((p) => p.value === normalizedPermission(value))
    ?.label ?? value;
export function PermissionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="permission-field">
      <legend>权限模式</legend>
      <div className="permission-options">
        {permissionOptions.map((option) => (
          <label
            key={option.value}
            className={
              normalizedPermission(value) === option.value ? "selected" : ""
            }
          >
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={normalizedPermission(value) === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p className="hint">
        {
          permissionOptions.find((p) => p.value === normalizedPermission(value))
            ?.detail
        }
      </p>
    </fieldset>
  );
}
