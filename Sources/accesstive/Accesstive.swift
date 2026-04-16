import ArgumentParser

@main
struct Accesstive: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "accesstive",
        abstract: "Accessibility testing tool for iOS using Mac native services.",
        version: "0.1.0",
        subcommands: [
            Inspect.self,
            Audit.self,
            ListDevices.self,
            Watch.self,
            Announcements.self,
            Navigate.self,
        ],
        defaultSubcommand: Inspect.self
    )
}
