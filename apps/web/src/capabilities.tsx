export const capabilityGroups = [
  {
    title: "对话",
    options: [
      ["collab.read", "阅读对话", "查看消息、上下文与待处理消息。"],
      ["collab.post", "发送消息", "发布回复，向其他参与成员提问。"],
    ],
  },
  {
    title: "任务",
    options: [
      ["task.read", "查看任务", "查看任务要求、进度和负责人。"],
      ["task.create", "创建任务", "将工作拆分为可跟踪的任务。"],
      ["task.claim", "领取任务", "认领任务并成为负责人。"],
      ["task.transition", "更新进度", "更新自己负责的任务状态、提交结果。"],
      ["task.review", "验收任务", "以审查者身份确认任务完成。"],
    ],
  },
  {
    title: "成果与记忆",
    options: [
      ["artifact.read", "读取成果", "查看共享文件、图片和测试报告。"],
      ["artifact.register", "提交成果", "将生成的文件或报告加入共享成果。"],
      [
        "memory.propose",
        "提议共享记忆",
        "提交供人确认的记忆，不会直接写入已认可的记忆。",
      ],
    ],
  },
];
export const defaultCapabilities = capabilityGroups.flatMap((g) =>
  g.options.map((o) => o[0]!),
);
export function CapabilityField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <details className="capability-picker">
      <summary>协作权限</summary>
      {capabilityGroups.map((group) => (
        <fieldset key={group.title}>
          <legend>{group.title}</legend>
          {group.options.map(([id, label, description]) => (
            <label key={id} className="capability-option">
              <input
                type="checkbox"
                checked={value.includes(id!)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, id!]
                      : value.filter((v) => v !== id),
                  )
                }
              />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </details>
  );
}

export function ComputerUseField({
  value,
  onChange,
  permission,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  permission: string;
}) {
  const eligible = ["auto-approve", "full-access"].includes(permission);
  return (
    <label className="capability-option computer-permission">
      <input
        type="checkbox"
        checked={eligible && value.includes("desktop.request")}
        disabled={!eligible}
        onChange={(e) =>
          onChange(
            e.target.checked
              ? [...new Set([...value, "desktop.request"])]
              : value.filter((v) => v !== "desktop.request"),
          )
        }
      />
      <span>
        <strong>Computer Use</strong>
        <small>
          {eligible
            ? "允许此成员操作电脑。默认关闭，应用授权仍由你确认。"
            : "切换为 Auto Approve 或 Full Access 后可开启。"}
        </small>
      </span>
    </label>
  );
}
